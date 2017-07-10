require('dotenv').config();
const os = require('os');
const fs = require('fs');

const crypto = require('crypto'), 
      ALGO = 'aes192', 
      SALT = process.env.SALT || process.env.BASEURL;

const moment = require('moment');
const request = require('request');

var app = require('express')();
var bodyParser = require('body-parser');
var server = require('http').createServer(app);
app.use(bodyParser.urlencoded({ extended: false }));


function SMSGlue(base64Token) {
  this.base64Token = base64Token;
  this.api_username = false;
  this.api_password = false;
  this.did = false;
  this.dst = false;
  this.msg = false;
  this.valid = false;
  this.identifier = false;
  
  try {

    // Decode and parse token JSON to object
    var token = JSON.parse(Buffer.from(this.base64Token, 'base64').toString());

    // Save token values
    this.api_username = token.api_username.trim();
    this.api_password = token.api_password.trim();
    this.did = token.did.replace(/\D/g,'');
    this.identifier = `smsglue-${this.encrypt(this.did, false)}`;

  } catch(e) {}

  // Validate token values (username is email address, password 8 charactors or more, did 10 digits)
  this.valid = ((this.api_username.toString().includes('@')) && (this.api_password.toString().length >= 8) && (this.did.toString().length == 10)) ? true : false;

  this.hooks = {

    // The front-end form submits to this URL to enable SMS on voip.ms and return the provision URL
    enable: {
      url:  `${process.env.BASEURL}/enable`,
      post: `token=${this.base64Token}`
    },

    // This URL must be manually entered into Acrobits Softphone/Groundwire to enabled the next URLs
    provision: {
      url:  `${process.env.BASEURL}/provision`,
      post: `token=${this.base64Token}`
    },

    // Acrobits calls this URL to send us the push token and app id (needed for notifications)
    push: {
      url:  `${process.env.BASEURL}/push`,
      post: `token=${this.base64Token}&device=%pushToken%&app=%pushappid%`
    },

    // This URL is added to voip.ms to be called whenever a new SMS is received (it deletes the local cache of SMSs)
    refresh: {
      url:  `${process.env.BASEURL}/refresh/${this.identifier}`
    },

    // Acrobits refresh the list of SMSs with this URL whenever the app is opened or a notification is received
    fetch: {
      url:  `${process.env.BASEURL}/fetch`,
      post: `token=${this.base64Token}&last_sms=%last_known_sms_id%`
    },

    // Acrobits submits to this URL to send SMS messages
    send: {
      url:  `${process.env.BASEURL}/send`,
      post: `token=${this.base64Token}&dst=%sms_to%&msg=%sms_body%`
    },

    // Acrobits checks this URL for the financial balance left on this account
    balance: {
      url:  `${process.env.BASEURL}/balance`,
      post: `token=${this.base64Token}`
    },

    // Acrobits checks this URL for current calling/messaging rates
    rate: {
      url:  `${process.env.BASEURL}/rate`,
      post: `token=${this.base64Token}&dst=%targetNumber%`
    },
  }
}

SMSGlue.cacheDirectory = function(category = 'messages', identifier) {
  return os.tmpdir() + `/${identifier}.${category}`;
}

SMSGlue.prototype.cacheDirectory = function(category = 'messages') {
  return SMSGlue.cacheDirectory(category, this.identifier);
}

SMSGlue.encrypt = function(text, salt=SALT, json=true) {
  text = (json) ? JSON.stringify(text) : text;
  var cipher = crypto.createCipher(ALGO, salt);
  var crypted = cipher.update(text, 'utf8', 'hex');
  crypted += cipher.final('hex');
  return crypted;
}

SMSGlue.prototype.encrypt = function(text, json=true) {
  return SMSGlue.encrypt(text, this.base64Token + SALT, json);
}

SMSGlue.decrypt = function(text, salt=SALT, json=true) {
  try {
    var decipher = crypto.createDecipher(ALGO, salt);
    var decrypted = decipher.update(text, 'hex', 'utf8')
    decrypted += decipher.final('utf8');
    return (json) ? JSON.parse(decrypted) : decrypted;

  } catch(e) {
    return false;
  }
}

SMSGlue.prototype.decrypt = function(text, json=true) {
  return SMSGlue.decrypt(text, this.base64Token + SALT, json);
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
    url_callback: this.hooks.refresh.url,
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
SMSGlue.notify = function(identifier) {

  // Read the cached push token and app id
  fs.readFile(SMSGlue.cacheDirectory('devices', identifier), 'utf8', (err, encrypted) => {

    // Decrypt and prep
    var devices = SMSGlue.decrypt(encrypted) || [];
    // console.log('devices', devices)
    var sent = 0, hasError = false, validDevices = [];

    // This will be called after each request, but only do anything after the final request
    var updateCachedDevices = function() {

      // If there was a push error, rewrite the devices file with on the valid devices
      if ((sent >= devices.length) && (hasError)) {
        fs.writeFile(SMSGlue.cacheDirectory('devices', identifier), SMSGlue.encrypt(validDevices), 'utf8');
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


// :token
app.post('/enable', (req, res) => {

  let glue = new SMSGlue(req.body.token);
  glue.enable( (err, r, body) => {

    if (body = SMSGlue.parseBody(body)) {
      res.setHeader('Content-Type', 'application/json');
      res.send({ response: { error: 0, description: 'Success', hooks: glue.hooks }});

    } else {
      res.setHeader('Content-Type', 'application/json');
      res.send({ response: { error: 400, description: 'Invalid parameters' }});
    }
  });
});



// :token
app.post('/provision', (req, res) => {

  var glue = new SMSGlue(req.body.token);
  xml  = '<account>';

  if (glue.valid) {
    xml += `<pushTokenReporterUrl>${glue.hooks.push.url}</pushTokenReporterUrl>`;
    xml += `<pushTokenReporterPostData>${glue.hooks.push.post}</pushTokenReporterPostData>`;

    xml += `<genericSmsFetchUrl>${glue.hooks.fetch.url}</genericSmsFetchUrl>`;
    xml += `<genericSmsFetchPostData>${glue.hooks.fetch.post}</genericSmsFetchPostData>`;

    xml += `<genericSmsSendUrl>${glue.hooks.send.url}</genericSmsSendUrl>`;
    xml += `<genericSmsPostData>${glue.hooks.send.post}</genericSmsPostData>`;

    // xml += `<genericBalanceCheckUrl>${glue.hooks.balance.url}</genericBalanceCheckUrl>`;
    xml += `<genericBalanceCheckPostData>${glue.hooks.balance.post}</genericBalanceCheckPostData>`;

    // xml += `<genericRateCheckUrl>${glue.hooks.rate.url}</genericRateCheckUrl>`;
    xml += `<genericRateCheckPostData>${glue.hooks.rate.post}</genericRateCheckPostData>`;
    xml += `<rateCheckMinNumberLength>3</rateCheckMinNumberLength>`;

    xml += '<allowMessage>1</allowMessage>';
    xml += '<voiceMailNumber>*97</voiceMailNumber>';
  }

  xml += '</account>';
  // console.log(xml);

  // Send account.xml with all web services URLs
  res.setHeader('Content-Type', 'text/xml');
  res.send(xml);
});



// :token, :device, :app
app.post('/push', (req, res) => {
  let glue = new SMSGlue(req.body.token);

  // Read existing devices file
  fs.readFile(glue.cacheDirectory('devices'), 'utf8', (err, encrypted) => {
    var devices = SMSGlue.decrypt(encrypted) || [];

    // Add this push token & app id to the array
    if ((req.body.device) && (req.body.app)) {
      devices.push({
        DeviceToken: req.body.device,
        AppId: req.body.app
      });
    }

    // Remove any duplicates
    devices = devices.filter((device, index, self) => self.findIndex((d) => {return d.DeviceToken === device.DeviceToken }) === index)

    // Save changes to disk
    fs.writeFile(glue.cacheDirectory('devices'), SMSGlue.encrypt(devices), 'utf8', (err) => {
      res.setHeader('Content-Type', 'application/json');
      res.send({ response: { error: 0, description: 'Success' }});
    });

  });
});


// :token, :dst, :msg
app.post('/send', (req, res) => {

  let glue = new SMSGlue(req.body.token);
  glue.send(req.body.dst, req.body.msg, (err, r, body) => {

    if (body = SMSGlue.parseBody(body)) {
      res.setHeader('Content-Type', 'application/json');
      res.send({ response: { error: 0, description: 'Success' }});

    } else {
      res.setHeader('Content-Type', 'application/json');
      res.send({ response: { error: 400, description: 'Invalid parameters' }});
    }
  });
});


// :identifier
app.get('/refresh/:identifier', (req, res) => {

  // Deleted the cached history
  fs.unlink(SMSGlue.cacheDirectory('messages', req.params.identifier), (err) => {

    // Send push notification to device(s) 
    SMSGlue.notify();

    // If it's all good, let it be known
    res.setHeader('Content-Type', 'application/json');
    res.send({ response: { error: 0, description: 'Success' }});
  });
});


// Fetch cached SMS messages, filtered by last SMS ID
// :token, :last_sms
app.post('/fetch', (req, res) => {

  var glue = new SMSGlue(req.body.token);
  var last_sms = Number(req.body.last_sms || 0);
  // console.log('fetch...', last_sms)

  // Fetch filtered SMS messages back as JSON
  var fetchFilteredSMS = function(smss) {
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
      fetchFilteredSMS(smss);

    // If the array is empty, update the cache from voip.ms and try again
    } else {
      // console.log('DID NOT find SMS cache')
      glue.get((error) => {

        // Read the cached messages one more time
        fs.readFile(glue.cacheDirectory('messages'), 'utf8', (err, data) => {

          // Decrypt the messages and send them back (last chance)
          smss = glue.decrypt(data) || [];
          fetchFilteredSMS(smss);

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


// :token
app.post('/balance', (req, res) => {

  var glue = new SMSGlue(req.body.token);
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
