require('dotenv').config();
const os = require('os');
const fs = require('fs');
const crypto = require('crypto'), algorithm = 'aes192';
const moment = require('moment');
const request = require('request');
var app = require('express')(), server = require('http').createServer(app);


function SMSGlue(base64Token) {
  this.base64Token = base64Token;
  this.api_username = false;
  this.api_password = false;
  this.did = false;
  this.dst = false;
  this.msg = false;
  this.valid = false;
  
  try {

    // Decode and parse token JSON to object
    var token = JSON.parse(Buffer.from(this.base64Token, 'base64').toString());

    // Save token values
    this.api_username = token.api_username.trim();
    this.api_password = token.api_password.trim();
    this.did = token.did.replace(/\D/g,'');

  } catch(e) {}

  // Validate token values (username is email address, password 8 charactors or more, did 10 digits)
  this.valid = ((this.api_username.toString().includes('@')) && (this.api_password.toString().length >= 8) && (this.did.toString().length == 10)) ? true : false;

  this.urls = {

    // The front-end form submits to this URL to enable SMS on voip.ms and return the provision URL
    enable:    `${process.env.BASEURL}/enable/${this.base64Token}`,

    // This URL must be manually entered into Acrobits Softphone/Groundwire to enabled the next URLs
    provision: `${process.env.BASEURL}/provision/${this.base64Token}`,

    // Acrobits calls this URL to send us the push token and app id (needed for notifications)
    push:      `${process.env.BASEURL}/push/${this.base64Token}/%pushToken%/%pushappid%`,

    // This URL is added to voip.ms to be called whenever a new SMS is received (it updates the local cache of SMSs from voip.ms)
    update:    `${process.env.BASEURL}/update/${this.base64Token}`,

    // Acrobits refresh the list of SMSs with this URL whenever the app is opened or a notification is received
    fetch:     `${process.env.BASEURL}/fetch/${this.base64Token}/%last_known_sms_id%`,

    // Acrobits submits to this URL to send SMS messages
    send:      `${process.env.BASEURL}/send/${this.base64Token}/%sms_to%/%sms_body%`,

    // Acrobits checks this URL for the financial balance left on this account
    balance:   `${process.env.BASEURL}/balance/${this.base64Token}`

    // // Acrobits checks this URL for current calling/messaging rates
    // rate:      `${process.env.BASEURL}/rate/${this.base64Token}/%targetNumber%`,
  }
}

SMSGlue.prototype.cacheDirectory = function(prefix = 'messages') {
  return os.tmpdir() + '/smsglue-' + prefix + '-' + this.encrypt(this.did, false);
}


SMSGlue.prototype.encrypt = function(text, json = true) {
  text = (json) ? JSON.stringify(text) : text;
  var cipher = crypto.createCipher(algorithm, this.base64Token);
  var crypted = cipher.update(text, 'utf8', 'hex');
  crypted += cipher.final('hex');
  return crypted;
}

SMSGlue.prototype.decrypt = function(text, json = true) {
  try {
    var decipher = crypto.createDecipher(algorithm, this.base64Token);
    var decrypted = decipher.update(text, 'hex', 'utf8')
    decrypted += decipher.final('utf8');
    return (json) ? JSON.parse(decrypted) : decrypted;

  } catch(e) {
    return false;
  }
}


SMSGlue.prototype.request = function(query = {}, callback) {
  let options = {
    method: 'GET',
    url: 'https://www.voip.ms/api/v1/rest.php',
    qs: {
      api_username: this.api_username,
      api_password: this.api_password,
      did: this.did
    }
  };
  Object.assign(options.qs, query);
  // console.log(options);
  request(options, callback);
}


// Parse request body, return object only if valid JSON and status == 'success'
SMSGlue.parseBody = function(body) {
  try {
    body = JSON.parse(body);
    return (body.status == 'success') ? body : false;

  } catch(e) {
    return false;
  }
} 


// Enable SMS messages in voip.ms account and set SMS URL Callback
SMSGlue.prototype.enable = function(cb) {
  this.request({ 
    method: 'setSMS',
    enable: 1,
    url_callback_enable: 1,
    url_callback: this.urls.update,
    url_callback_retry: 1
  }, cb);
}


// Send SMS message
SMSGlue.prototype.send = function(dst, msg, cb) {

  // Clean up number and message text
  dst = dst.replace(/\D/g,'');
  msg = msg.trim();

  // Validate destination number and message text
  if ((dst.length != 10) || (msg.length < 1))  { 
    cb();
    return;
  }

  // Submit request to send message
  this.request({ 
    method: 'sendSMS',
    dst: dst,
    message: msg
  }, cb);
}


// Get SMS messages
SMSGlue.prototype.get = function(cb) {

  // Query voip.ms for received SMS messages ranging from 90 days ago to tomorrow
  this.request({ 
    method: 'getSMS',
    from: moment().subtract(90, 'days').format('YYYY-MM-DD'),
    to: moment().add(1, 'day').format('YYYY-MM-DD'),
    limit: 9999,
    type: 1

  // Wait for it... 
  }, (err, r, body) => {

    // console.log(body);

    // Go on if there aren't any errors in the body
    if (body = SMSGlue.parseBody(body)) {

      // Collect all SMS messages in an array of objects with the proper keys and formatting
      var smss = body.sms.map( (sms) => {
        return {
          sms_id: Number(sms.id),
          sending_date: moment(sms.date).format("YYYY-MM-DDTHH:mm:ssZ"),
          sender: sms.contact.replace(/\D/g,''),
          sms_text: sms.message
        }
      });

      // Save this as a encrypted json file and hit the callback when done
      fs.writeFile(this.cacheDirectory('messages'), this.encrypt(smss), 'utf8', cb);

    // Whoops, there was an error. Hit the callback with the error argument true
    } else {
      cb(true);
    }
  
  });
}

// Send notification messages to all devices under this account
SMSGlue.prototype.notify = function() {

  // Read the cached push token and app id
  fs.readFile(this.cacheDirectory('devices'), 'utf8', (err, encrypted) => {
    
    // Decrypt and prep
    var devices = this.decrypt(encrypted) || [];
    // console.log('devices', devices)
    var sent = 0, hasError = false, validDevices = [];

    // This will be called after each request, but only do anything after the final request
    var updateCachedDevices = function() {

      // If there was a push error, rewrite the devices file with on the valid devices
      if ((sent >= devices.length) && (hasError)) {
        fs.writeFile(this.cacheDirectory('devices'), this.encrypt(validDevices), 'utf8');
      }
    }

    // Send push notification to all devices on this account
    devices.forEach((device) => {

      request({
        method: 'POST',
        url: 'https://pnm.cloudsoftphone.com/pnm2',
        form: {
          verb: 'NotifyTextMessage',
          AppId: device.AppId,
          DeviceToken: device.DeviceToken
        }

      // On complete, add 1 to the sent counter, flag if there was an error (or add valid device if not) and call function above
      }, (error) => {
        sent++;
        if (error) hasError = true;
        else validDevices.push(device);
        updateCachedDevices();
      });
    });
  });
}


SMSGlue.prototype.balance = function(cb) {
  this.request({ 
    method: 'getBalance',
  }, cb);
}


app.get('/enable/:token', (req, res) => {

  let glue = new SMSGlue(req.params.token);
  glue.enable( (err, r, body) => {

    if (body = SMSGlue.parseBody(body)) {
      res.setHeader('Content-Type', 'application/json');
      res.send({ response: { error: 0, description: 'Success', urls: glue.urls }});

    } else {
      res.setHeader('Content-Type', 'application/json');
      res.send({ response: { error: 400, description: 'Invalid parameters' }});
    }
  });
});



app.get('/provision/:token', (req, res) => {

  var glue = new SMSGlue(req.params.token);
  xml  = '<account>';

  if (glue.valid) {
    xml += `<pushTokenReporterUrl>${glue.urls.push}</pushTokenReporterUrl>`;
    xml += `<genericSmsFetchUrl>${glue.urls.fetch}</genericSmsFetchUrl>`;
    xml += `<genericSmsSendUrl>${glue.urls.send}</genericSmsSendUrl>`;
    xml += `<genericBalanceCheckUrl>${glue.urls.balance}</genericBalanceCheckUrl>`;
    // xml += `<genericRateCheckUrl>${glue.urls.rate}</genericRateCheckUrl>`;
    // xml += `<rateCheckMinNumberLength>3</rateCheckMinNumberLength>`;
    xml += '<allowMessage>1</allowMessage>';
    xml += '<voiceMailNumber>*97</voiceMailNumber>';
  }

  xml += '</account>';
  // console.log(xml);

  // Send account.xml with all web services URLs
  res.setHeader('Content-Type', 'text/xml');
  res.send(xml);
});



app.get('/push/:token/:device/:app', (req, res) => {
  let glue = new SMSGlue(req.params.token);

  // Read existing devices file
  fs.readFile(glue.cacheDirectory('devices'), 'utf8', (err, encrypted) => {
    var devices = glue.decrypt(encrypted) || [];

    // Add this push token & app id to the array
    devices.push({
      DeviceToken: req.params.device,
      AppId: req.params.app
    })

    // Remove any duplicates
    devices = devices.filter((device, index, self) => self.findIndex((d) => {return d.DeviceToken === device.DeviceToken }) === index)

    // Save changes to disk
    fs.writeFile(glue.cacheDirectory('devices'), glue.encrypt(devices), 'utf8', (err) => {
      res.setHeader('Content-Type', 'application/json');
      res.send({ response: { error: 0, description: 'Success' }});
    });

  });
});


app.get('/send/:token/:dst/:msg', (req, res) => {

  let glue = new SMSGlue(req.params.token);
  glue.send(req.params.dst, req.params.msg, (err, r, body) => {

    if (body = SMSGlue.parseBody(body)) {
      res.setHeader('Content-Type', 'application/json');
      res.send({ response: { error: 0, description: 'Success' }});

    } else {
      res.setHeader('Content-Type', 'application/json');
      res.send({ response: { error: 400, description: 'Invalid parameters' }});
    }
  });
});



app.get('/update/:token', (req, res) => {

  // Update the local cache for SMS messages
  var glue = new SMSGlue(req.params.token);
  glue.get((error) => {

    // If there was an error, send an error message
    if (error) {
      res.setHeader('Content-Type', 'application/json');
      res.send({ response: { error: 400, description: 'Invalid parameters' }});

    // No errors...
    } else {

      // Send push notification to device(s) 
      glue.notify();

      // If it's all good, let it be known
      res.setHeader('Content-Type', 'application/json');
      res.send({ response: { error: 0, description: 'Success' }});
    }
  });
});


// Fetch cached SMS messages, filtered by last SMS ID
app.get(['/fetch/:token', '/fetch/:token/:last_sms'], (req, res) => {

  var glue = new SMSGlue(req.params.token);
  var last_sms = Number(req.params.last_sms || 0);
  // console.log('fetch...', last_sms)

  // Send filtered SMS messages back as JSON
  var sendFilteredSMS = function(smss) {
    res.setHeader('Content-Type', 'application/json');
    res.send({
      date: moment().format("YYYY-MM-DDTHH:mm:ssZ"),
      unread_smss: smss.filter((sms) => (Number(sms.sms_id) > last_sms))
    });
  }

  // First try to read the cached messages
  fs.readFile(glue.cacheDirectory('messages'), 'utf8', (err, data) => {

    // Decrypt the messages and send them back
    var smss = glue.decrypt(data) || [];
    if (smss.length) {
      // console.log('Found SMS cache')
      sendFilteredSMS(smss);

    // If the array is empty, update the cache from voip.ms and try again
    } else {
      // console.log('DID NOT find SMS cache')
      glue.get((error) => {

        // Read the cached messages one more time
        fs.readFile(glue.cacheDirectory('messages'), 'utf8', (err, data) => {

          // Decrypt the messages and send them back (last chance)
          smss = glue.decrypt(data) || [];
          sendFilteredSMS(smss);

        });
      });
    }
  });      
})


// app.get('/rate/:token/:dst', (req, res) => {
//
//   var glue = new SMSGlue(req.params.token);
//   var dst = Number(req.params.dst);
//
//   var response = {
//     "callRateString" : "1¢ / min",
//     "messageRateString" : "5¢"
//   }
//
//   res.setHeader('Content-Type', 'application/json');
//   res.send(response);
// });


app.get('/balance/:token', (req, res) => {

  var glue = new SMSGlue(req.params.token);
  glue.balance((err, r, body) => {

    if (body = SMSGlue.parseBody(body)) {
      let amount = Number(body.balance.current_balance) || 0;
      res.setHeader('Content-Type', 'application/json');
      res.send({
        "balanceString": amount.toFixed(2),
        "balance": amount,
        "currency": "US"
      });

    } else {
      res.setHeader('Content-Type', 'application/json');
      res.send({ response: { error: 400, description: 'Invalid parameters' }});
    }
  });
});


// homepage
app.get('/', function (req, res) {
    res.sendFile(__dirname + '/public/index.html');
});

app.listen(process.env.PORT);
console.log(`Listening on port ${process.env.PORT}`);
