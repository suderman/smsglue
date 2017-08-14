const os = require('os');
const fs = require('fs');
const path = require('path')
const log = require('npmlog');
const crypto = require('crypto');
const moment = require('moment');
const request = require('request');

function SMSglue(token, origin = '', currency = false) {
  this.token = token;
  this.origin = origin;
  this.currency = currency;
  this.user = false;
  this.pass = false;
  this.did = false;
  this.dst = false;
  this.msg = false;
  this.valid = false;
  this.id = false;
  
  try {

    // Decode and parse token JSON to object
    var decryptedToken = SMSglue.decrypt(this.token.split('-')[1]);

    // Save token values
    this.user = decryptedToken.user.trim();
    this.pass = decryptedToken.pass.trim();
    this.did = decryptedToken.did.replace(/\D/g,'');

    // Determine identifer from DID
    this.id = this.did.substring(6) + '-' + SMSglue.encrypt(this.did);

  } catch(e) {}

  // Validate token values (username is email address, password 8 charactors or more, did 10 digits)
  this.valid = ((this.user.toString().includes('@')) && (this.pass.toString().length >= 8) && (this.did.toString().length == 10)) ? true : false;

  this.hooks = {

    // This URL must be manually entered into Acrobits Softphone/Groundwire to enabled the next URLs
    provision: `${this.origin}/provision/${this.id}`,

    // Acrobits calls this URL to send us the push token and app id (needed for notifications)
    report: `${this.origin}/report/${this.id}/%pushToken%/%pushappid%`,

    // This URL is added to voip.ms to be called whenever a new SMS is received (it deletes the local cache of SMSs)
    notify: `${this.origin}/notify/${this.id}`,

    // Acrobits refresh the list of SMSs with this URL whenever the app is opened or a notification is received
    fetch: `${this.origin}/fetch/${this.token}/%last_known_sms_id%`,

    // Acrobits submits to this URL to send SMS messages
    send: `${this.origin}/send/${this.token}/%sms_to%/%sms_body%`
  }

  if (this.currency) {

    // Acrobits checks this URL for the financial balance left on this account
    this.hooks.balance = `${this.origin}/balance/${this.token}/${this.currency}`;

    // Acrobits checks this URL for current calling/messaging rates
    // this.hooks.rate = `${this.origin}/rate/${this.token}/%targetNumber%`
  }
}


// STATIC FUNCTIONS

SMSglue.save = function(type, id, value, cb = function(){}) {
  var filename = path.resolve('cache', type, id);
  fs.writeFile(filename, value, 'utf8', cb);
}

SMSglue.load = function(type, id, cb = function(){}) {
  var filename = path.resolve('cache', type, id);
  fs.readFile(filename, 'utf8', cb);
}

SMSglue.clear = function(type, id, cb = function(){}) {
  var filename = path.resolve('cache', type, id);
  fs.unlink(filename, cb);
}

// Get crypto key (and generate if it doesn't exist yet)
SMSglue.load('key', 'key', (err, key) => {
  SMSglue.KEY = key;
  if (err) {
    SMSglue.KEY = require('randomstring').generate();
    SMSglue.save('key', 'key', SMSglue.KEY);
  }
});
SMSglue.ALGO = 'aes192';

SMSglue.encrypt = function(text, salt=false) {
  var key = (salt) ? SMSglue.KEY+salt : SMSglue.KEY;
  var cipher = crypto.createCipher(SMSglue.ALGO, key);
  var crypted = cipher.update(JSON.stringify(text), 'utf8', 'hex');
  crypted += cipher.final('hex');
  return crypted;
}

SMSglue.decrypt = function(text, salt=false) {
  var key = (salt) ? SMSglue.KEY+salt : SMSglue.KEY;
  try {
    var decipher = crypto.createDecipher(SMSglue.ALGO, key);
    var decrypted = decipher.update(text, 'hex', 'utf8')
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);

  } catch(e) {
    return false;
  }
}


// Update exchange rates from Open Exchange Rates API
SMSglue.updateRates = function() {
  request({
    method: 'GET',
    url: 'https://openexchangerates.org/api/latest.json',
    qs: { app_id: process.env.OPEN_EXCHANGE_RATES },
    json: true

  }, (error, httpResponse, body) => {
    if (error) return;
    if (body.rates.USD) {
      SMSglue.RATES = {};
      ['USD','CAD'].forEach((key) => {
        if (body.rates[key]) {
          SMSglue.RATES[key] = body.rates[key];
          delete body.rates[key];
        }
      });
      Object.keys(body.rates).forEach((key) => {
        SMSglue.RATES[key] = body.rates[key];
      });
    }
  });
}

// Set exchange rates every 24 hours if API token set
SMSglue.RATES = { "USD": 1 };
if (process.env.OPEN_EXCHANGE_RATES) {
  setInterval(SMSglue.updateRates, 86400000);
  SMSglue.updateRates();
}

SMSglue.date = function(d=undefined) {
  return moment.utc(d).format("YYYY-MM-DDTHH:mm:ss.SSZ");
}

// Parse request body, return object only if valid JSON and status == 'success'
SMSglue.parseBody = function(body) {
  try {
    body = JSON.parse(body);
    return (body.status == 'success') ? body : false;

  } catch(e) {
    return false;
  }
} 

// Send notification messages to all devices under this account
SMSglue.notify = function(id, cb) {

  // Read the cached push token and app id
  SMSglue.load('devices', id, (err, encrypted) => {

    // Decrypt and prep
    var sent = 0, hasError = false, validDevices = [];
    var devices = SMSglue.decrypt(encrypted) || [];

    // No devices to notify, hit the callback now
    if (!devices.length) cb();

    // This will be called after each request, but only do anything after the final request
    var updateCachedDevices = function() {
      log.info('updateCachedDevices', `sent count: ${sent}`);
      
      // If number of messages sent matches the number of devices...
      if (sent >= devices.length) {
        log.info('updateCachedDevices', 'sent matches device length');

        // If there was a push error, rewrite the devices file with on the valid devices
        if (hasError) {
          SMSglue.save('devices', id, SMSglue.encrypt(validDevices));
        }

        // All finished, hit the callback
        cb();
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


// INSTANCE METHODS

SMSglue.prototype.request = function(query = {}, callback) {
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
  request(options, callback);
}


// Enable SMS messages in voip.ms account and set SMS URL Callback
SMSglue.prototype.enable = function(cb) {
  this.request({ 
    method: 'setSMS',
    enable: 1,
    url_callback_enable: 1,
    url_callback: this.hooks.notify.url,
    url_callback_retry: 1
  }, cb);
}


// Send SMS message
SMSglue.prototype.send = function(dst, msg, cb) {

  // Clean up number and message text
  dst = dst.replace(/\D/g,'');
  msg = msg.trim();

  // Remove leading '1' on 11-digit phone numbers
  if ((dst.length == 11) && (dst.charAt(0) == '1')) {
    dst = dst.slice(1);
  }

  // Validate destination number and message text
  if ((dst.length != 10) || (msg.length < 1))  { 
    cb(true);
    return;
  }

  // Recursively send 160 character chunks
  var sendMessage = (message = '') => {
    log.info(`${this.did} -> ${dst}`, message);

    var thisMessage = message.substring(0, 160);
    var nextMessage = message.substring(160);
    var callback = (nextMessage.length) ? () => { sendMessage(nextMessage) } : cb; 

    // Submit request to send message
    this.request({ 
      method: 'sendSMS',
      dst: dst,
      message: thisMessage,
    }, callback);
  }

  // Start it off
  sendMessage(msg);
}


// Get SMS messages
SMSglue.prototype.get = function(cb) {

  // Query voip.ms for received SMS messages ranging from 90 days ago to tomorrow
  this.request({ 
    method: 'getSMS',
    from: moment.utc().subtract(90, 'days').format('YYYY-MM-DD'),
    to: moment.utc().add(1, 'day').format('YYYY-MM-DD'),
    limit: 9999,
    type: 1,
    timezone: -1

  // Wait for it... 
  }, (err, r, body) => {

    // Go on if there aren't any errors in the body
    if (body = SMSglue.parseBody(body)) {

      // Collect all SMS messages in an array of objects with the proper keys and formatting
      var smss = body.sms.map( (sms) => {
        return {
          sms_id: Number(sms.id),
          sending_date: SMSglue.date(sms.date),
          sender: sms.contact.replace(/\D/g,''),
          sms_text: sms.message
        }
      });

      // Save this as a encrypted json file and hit the callback when done
      SMSglue.save('messages', this.id, SMSglue.encrypt(smss, this.pass), cb);

    // Whoops, there was an error. Hit the callback with the error argument true
    } else {
      cb(true);
    }
  
  });
}


SMSglue.prototype.accountXML = function() {
  xml  = '<account>';

  if (this.valid) {
    if (this.hooks.report)  xml += `<pushTokenReporterUrl>${this.hooks.report}</pushTokenReporterUrl>`;
    if (this.hooks.fetch)   xml += `<genericSmsFetchUrl>${this.hooks.fetch}</genericSmsFetchUrl>`;
    if (this.hooks.send)    xml += `<genericSmsSendUrl>${this.hooks.send}</genericSmsSendUrl>`;
    if (this.hooks.balance) xml += `<genericBalanceCheckUrl>${this.hooks.balance}</genericBalanceCheckUrl>`;
    if (this.hooks.rate)    xml += `<genericRateCheckUrl>${this.hooks.rate}</genericRateCheckUrl>`;
    if (this.hooks.rate)    xml += `<rateCheckMinNumberLength>3</rateCheckMinNumberLength>`;
    xml += '<allowMessage>1</allowMessage>';
    xml += '<voiceMailNumber>*97</voiceMailNumber>';
  }

  xml += '</account>';
  return xml;
}

SMSglue.prototype.balance = function(cb) {
  this.request({ 
    method: 'getBalance',
  }, cb);
}

module.exports = SMSglue;
