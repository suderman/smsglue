require('dotenv').config();
const os = require('os');
const fs = require('fs');

const crypto = require('crypto'), 
      ALGO = 'aes192', 
      KEY = process.env.KEY || process.env.BASEURL;

const moment = require('moment');
const request = require('request');

var app = require('express')();
var bodyParser = require('body-parser');
var server = require('http').createServer(app);
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

var TIMER = {};

function SMSGlue(token) {
  this.token = token;
  this.user = false;
  this.pass = false;
  this.did = false;
  this.dst = false;
  this.msg = false;
  this.valid = false;
  this.id = false;
  
  try {

    // Decode and parse token JSON to object
    var decryptedToken = SMSGlue.decrypt(token);

    // Save token values
    this.user = decryptedToken.user.trim();
    this.pass = decryptedToken.pass.trim();
    this.did = decryptedToken.did.replace(/\D/g,'');

    // Determine identifer from DID
    this.id = SMSGlue.encrypt(this.did);

  } catch(e) {}

  // Validate token values (username is email address, password 8 charactors or more, did 10 digits)
  this.valid = ((this.user.toString().includes('@')) && (this.pass.toString().length >= 8) && (this.did.toString().length == 10)) ? true : false;

  this.hooks = {

    // The front-end form submits to this URL to enable SMS on voip.ms and return the provision URL
    enable: {
      url:  `${process.env.BASEURL}`,
      post: JSON.stringify({ 
        action: 'enable',
        user: '',
        pass: '',
        did: ''
      })
    },

    // This URL must be manually entered into Acrobits Softphone/Groundwire to enabled the next URLs
    provision: {
      url:  `${process.env.BASEURL}/?p=${this.id}`
    },

    // Acrobits calls this URL to send us the push token and app id (needed for notifications)
    push: {
      url:  `${process.env.BASEURL}`,
      post: JSON.stringify({
        action: 'push',
        device: '%pushToken%',
        app: '%pushappid%',
        token: this.token
      })
    },

    // This URL is added to voip.ms to be called whenever a new SMS is received (it deletes the local cache of SMSs)
    notify: {
      url:  `${process.env.BASEURL}/?n=${this.id}`
    },

    // Acrobits refresh the list of SMSs with this URL whenever the app is opened or a notification is received
    fetch: {
      url:  `${process.env.BASEURL}`,
      post: JSON.stringify({
        action: 'fetch',
        last_sms: '%last_known_sms_id%',
        token: this.token
      })
    },

    // Acrobits submits to this URL to send SMS messages
    send: {
      url:  `${process.env.BASEURL}`,
      post: JSON.stringify({
        action: 'send',
        dst: '%sms_to%',
        msg: '%sms_body%',
        token: this.token
      })
    },

    // Acrobits checks this URL for the financial balance left on this account
    balance: {
      url:  `${process.env.BASEURL}`,
      post: JSON.stringify({ 
        action: 'balance',
        token: this.token 
      })
    },

    // Acrobits checks this URL for current calling/messaging rates
    rate: {
      url:  `${process.env.BASEURL}`,
      post: JSON.stringify({
        action: 'rate',
        dst: '%targetNumber%',
        token: this.token
      })
    },
  }
}


SMSGlue.cache = function(id, category) {
  return os.tmpdir() + `/SMSglue-${id}.${category}`;
}

SMSGlue.encrypt = function(text, key=KEY) {
  var cipher = crypto.createCipher(ALGO, key);
  var crypted = cipher.update(JSON.stringify(text), 'utf8', 'hex');
  crypted += cipher.final('hex');
  return crypted;
}

SMSGlue.decrypt = function(text, key=KEY) {
  try {
    var decipher = crypto.createDecipher(ALGO, key);
    var decrypted = decipher.update(text, 'hex', 'utf8')
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);

  } catch(e) {
    return false;
  }
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


SMSGlue.prototype.request = function(query = {}, callback) {
  let options = {
    method: 'GET',
    url: 'https://www.voip.ms/api/v1/rest.php',
    qs: {
      api_username: this.user,
      api_password: this.pass,
      did: this.did
    }
  };
  Object.assign(options.qs, query);
  // console.log(options);
  request(options, callback);
}


// Enable SMS messages in voip.ms account and set SMS URL Callback
SMSGlue.prototype.enable = function(cb) {
  this.request({ 
    method: 'setSMS',
    enable: 1,
    url_callback_enable: 1,
    url_callback: this.hooks.notify.url,
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
      fs.writeFile(SMSGlue.cache(this.id, 'messages'), SMSGlue.encrypt(smss, KEY + this.pass), 'utf8', cb);

    // Whoops, there was an error. Hit the callback with the error argument true
    } else {
      cb(true);
    }
  
  });
}


SMSGlue.prototype.accountXML = function() {
  xml  = '<account>';

  if (this.valid) {
    xml += `<pushTokenReporterUrl>${this.hooks.push.url}</pushTokenReporterUrl>`;
    xml += `<pushTokenReporterPostData>${this.hooks.push.post}</pushTokenReporterPostData>`;
    xml += `<pushTokenReporterContentType>application/json</pushTokenReporterContentType>`;

    xml += `<genericSmsFetchUrl>${this.hooks.fetch.url}</genericSmsFetchUrl>`;
    xml += `<genericSmsFetchPostData>${this.hooks.fetch.post}</genericSmsFetchPostData>`;
    xml += `<genericSmsFetchContentType>application/json</genericSmsFetchContentType>`;
    
    xml += `<genericSmsSendUrl>${this.hooks.send.url}</genericSmsSendUrl>`;
    xml += `<genericSmsPostData>${this.hooks.send.post}</genericSmsPostData>`;
    xml += `<genericSmsContentType>application/json</genericSmsContentType>`;

    // xml += `<genericBalanceCheckUrl>${this.hooks.balance.url}</genericBalanceCheckUrl>`;
    // xml += `<genericBalanceCheckPostData>${this.hooks.balance.post}</genericBalanceCheckPostData>`;

    // xml += `<genericRateCheckUrl>${this.hooks.rate.url}</genericRateCheckUrl>`;
    // xml += `<genericRateCheckPostData>${this.hooks.rate.post}</genericRateCheckPostData>`;
    // xml += `<rateCheckMinNumberLength>3</rateCheckMinNumberLength>`;

    xml += '<allowMessage>1</allowMessage>';
    xml += '<voiceMailNumber>*97</voiceMailNumber>';
  }

  xml += '</account>';
  return xml;
}


// Send notification messages to all devices under this account
SMSGlue.notify = function(id) {

  // Read the cached push token and app id
  fs.readFile(SMSGlue.cache(id, 'devices'), 'utf8', (err, encrypted) => {

    // Decrypt and prep
    var devices = SMSGlue.decrypt(encrypted) || [];
    // console.log('devices', devices)
    var sent = 0, hasError = false, validDevices = [];

    // This will be called after each request, but only do anything after the final request
    var updateCachedDevices = function() {

      // If there was a push error, rewrite the devices file with on the valid devices
      if ((sent >= devices.length) && (hasError)) {
        fs.writeFile(SMSGlue.cache(id, 'devices'), SMSGlue.encrypt(validDevices), 'utf8', function(){});
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







app.post('/', function (req, res) {
  console.log(req.body.action);
  if (app.actions[req.body.action]) {
    app.actions[req.body.action](req.body, res);

  } else {
    res.setHeader('Content-Type', 'application/json');
    res.send({ response: { error: 400, description: 'Invalid parameters' }});
  }
});


app.get('/', function (req, res) {

  if (req.query.p) {
    app.actions.provision(req.query.p, res);

  } else if (req.query.n) {
    app.actions.notify(req.query.n, res);

  } else {
    res.sendFile(__dirname + '/public/index.html');
  }
});



app.actions = {};


app.actions.provision = function(id, res) {

  fs.readFile(SMSGlue.cache(id, 'provision'), 'utf8', (err, encrypted) => {
    var xml = SMSGlue.decrypt(encrypted) || '<account></account>';

    // If the file exists, empty this xml file (only "<account></account>") 
    if (!err) {
      if (TIMER[id]) clearTimeout(TIMER[id]);
      fs.writeFile(SMSGlue.cache(id, 'provision'), SMSGlue.encrypt('<account></account>'), 'utf8', function(){});
    }

    res.setHeader('Content-Type', 'text/xml');
    res.send(xml);
  });
}

app.actions.notify = function(id, res) {
  
  // Deleted the cached history
  fs.unlink(SMSGlue.cache(id, 'messages'), (err) => {

    // Send push notification to device(s) 
    SMSGlue.notify(id);

    // If it's all good, let it be known
    res.setHeader('Content-Type', 'application/json');
    res.send({ response: { error: 0, description: 'Success' }});
  });
}


app.actions.enable = function(params, res) {

  let token = SMSGlue.encrypt({
    user: params.user || '',
    pass: params.pass || '',
     did: params.did  || ''
  });
  

  let glue = new SMSGlue(token);
  glue.enable( (err, r, body) => {

    if (body = SMSGlue.parseBody(body)) {

      fs.writeFile(SMSGlue.cache(glue.id, 'provision'), SMSGlue.encrypt(glue.accountXML()), 'utf8', () => {

        // Auto-empty this xml file (only "<account></account>") after 10 minutes of waiting...
        if (TIMER[this.id]) clearTimeout(TIMER[this.id]);
        TIMER[this.id] = setTimeout(() => {
          fs.writeFile(SMSGlue.cache(glue.id, 'provision'), SMSGlue.encrypt('<account></account>'), 'utf8', function(){});
        }, 600000)
      
        res.setHeader('Content-Type', 'application/json');
        res.send({ response: { error: 0, description: 'Success', hooks: glue.hooks }});
      });


    } else {
      res.setHeader('Content-Type', 'application/json');
      res.send({ response: { error: 400, description: 'Invalid parameters' }});
    }
  });
}


app.actions.push = function(params, res) {
  let glue = new SMSGlue(params.token);

  // Read existing devices file
  fs.readFile(SMSGlue.cache(glue.id, 'devices'), 'utf8', (err, encrypted) => {
    var devices = SMSGlue.decrypt(encrypted) || [];

    // Add this push token & app id to the array
    if ((params.device) && (params.app)) {
      devices.push({
        DeviceToken: params.device,
        AppId: params.app
      });
    }

    // Remove any duplicates
    devices = devices.filter((device, index, self) => self.findIndex((d) => {return d.DeviceToken === device.DeviceToken }) === index)

    // Save changes to disk
    fs.writeFile(SMSGlue.cache(glue.id, 'devices'), SMSGlue.encrypt(devices), 'utf8', (err) => {
      res.setHeader('Content-Type', 'application/json');
      res.send({ response: { error: 0, description: 'Success' }});
    });

  });
}


// Fetch cached SMS messages, filtered by last SMS ID
app.actions.fetch = function(params, res) {
  var glue = new SMSGlue(params.token);
  var last_sms = Number(params.last_sms || 0);
  console.log('fetch...', last_sms)

  // Fetch filtered SMS messages back as JSON
  var fetchFilteredSMS = function(smss) {
    // console.log({
    //   date: moment().format("YYYY-MM-DDTHH:mm:ssZ"),
    //   unread_smss: smss.filter((sms) => (Number(sms.sms_id) > last_sms))
    // });
    res.setHeader('Content-Type', 'application/json');
    res.send({
      date: moment().format("YYYY-MM-DDTHH:mm:ssZ"),
      unread_smss: smss.filter((sms) => (Number(sms.sms_id) > last_sms))
    });
  }

  // First try to read the cached messages
  fs.readFile(SMSGlue.cache(glue.id, 'messages'), 'utf8', (err, data) => {

    // Decrypt the messages and send them back
    var smss = SMSGlue.decrypt(data, KEY + glue.pass) || [];
    if (smss.length) {
      console.log('Found SMS cache')
      fetchFilteredSMS(smss);

    // If the array is empty, update the cache from voip.ms and try again
    } else {
      console.log('DID NOT find SMS cache')
      glue.get((error) => {

        // Read the cached messages one more time
        fs.readFile(SMSGlue.cache(glue.id, 'messages'), 'utf8', (err, data) => {

          // Decrypt the messages and send them back (last chance)
          smss = SMSGlue.decrypt(data, KEY + glue.pass) || [];
          fetchFilteredSMS(smss);

        });
      });
    }
  });   
}

app.actions.send = function(params, res) {
  let glue = new SMSGlue(params.token);
  glue.send(params.dst, params.msg, (err, r, body) => {

    if (body = SMSGlue.parseBody(body)) {
      res.setHeader('Content-Type', 'application/json');
      res.send({ response: { error: 0, description: 'Success' }});

    } else {
      res.setHeader('Content-Type', 'application/json');
      res.send({ response: { error: 400, description: 'Invalid parameters' }});
    }
  });
}

app.actions.balance = function(params, res) {
  var glue = new SMSGlue(params.token);
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
}

app.actions.rate = function(params, res) {
  var glue = new SMSGlue(params.token);
  var dst = Number(params.dst);

  var response = {
    "callRateString" : "1¢ / min",
    "messageRateString" : "5¢"
  }

  res.setHeader('Content-Type', 'application/json');
  res.send(response);
}





app.listen(process.env.PORT);
console.log(`Listening on port ${process.env.PORT}`);
