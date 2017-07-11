const fs = require('fs');
const path = require('path')

var SMSglue = require('./smsglue')

var express = require('express');
var app = express();
var bodyParser = require('body-parser');
var server = require('http').createServer(app);

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(['/','*'], express.static('public'))

var TIMER = {};

app.post('/', (req, res) => {
  console.log(req)
  console.log('Action: ', req.body.action);
  if (app.actions[req.body.action]) {
    app.actions[req.body.action](req.body, res);

  } else {
    res.setHeader('Content-Type', 'application/json');
    res.send({ response: { error: 400, description: 'Invalid parameters' }});
  }
});


app.get('/:action/:id', (req, res) => {
  console.log('Action: ', req.params.action);
  if (app.actions[req.params.action]) {
    app.actions[req.body.action](req.params.id, res);

  } else {
    res.setHeader('Content-Type', 'application/json');
    res.send({ response: { error: 400, description: 'Invalid parameters' }});
  }
});

app.actions = {};

app.actions.provision = (id, res) => {

  fs.readFile(SMSglue.cache(id, 'provision'), 'utf8', (err, encrypted) => {
    var xml = SMSglue.decrypt(encrypted) || '<account></account>';

    // If the file exists, empty this xml file (only "<account></account>") 
    if (!err) {
      if (TIMER[id]) clearTimeout(TIMER[id]);
      fs.writeFile(SMSglue.cache(id, 'provision'), SMSglue.encrypt('<account></account>'), 'utf8', function(){});
    }

    res.setHeader('Content-Type', 'text/xml');
    res.send(xml);
  });
}

app.actions.notify = (id, res) => {
  
  // Deleted the cached history
  fs.unlink(SMSglue.cache(id, 'messages'), (err) => {

    // Send push notification to device(s) 
    SMSglue.notify(id, () => {
    
      // voip.ms expects this reply, otherwise it'll retry every 30 minutes
      res.setHeader('Content-Type', 'text/plain');
      res.send('ok');

    });
  });
}


app.actions.enable = (params, res) => {

  let token = SMSglue.encrypt({
    user: params.user || '',
    pass: params.pass || '',
     did: params.did  || ''
  });
  

  let glue = new SMSglue(token);
  glue.enable( (err, r, body) => {

    if (body = SMSglue.parseBody(body)) {

      fs.writeFile(SMSglue.cache(glue.id, 'provision'), SMSglue.encrypt(glue.accountXML()), 'utf8', () => {

        // Auto-empty this xml file (only "<account></account>") after 10 minutes of waiting...
        if (TIMER[this.id]) clearTimeout(TIMER[this.id]);
        TIMER[this.id] = setTimeout(() => {
          fs.writeFile(SMSglue.cache(glue.id, 'provision'), SMSglue.encrypt('<account></account>'), 'utf8', function(){});
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


app.actions.push = (params, res) => {

  // Read existing devices file
  fs.readFile(SMSglue.cache(params.id, 'devices'), 'utf8', (err, encrypted) => {
    var devices = SMSglue.decrypt(encrypted) || [];

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
    fs.writeFile(SMSglue.cache(params.id, 'devices'), SMSglue.encrypt(devices), 'utf8', (err) => {
      res.setHeader('Content-Type', 'application/json');
      res.send({ response: { error: 0, description: 'Success' }});
    });

  });
}


// Fetch cached SMS messages, filtered by last SMS ID
app.actions.fetch = (params, res) => {
  var glue = new SMSglue(params.token);
  var last_sms = Number(params.last_sms || 0);
  console.log('last_sms ', last_sms)

  // Fetch filtered SMS messages back as JSON
  var fetchFilteredSMS = function(smss) {
    res.setHeader('Content-Type', 'application/json');
    res.send({
      date: SMSglue.date(),
      unread_smss: smss.filter((sms) => (Number(sms.sms_id) > last_sms))
    });
  }

  // First try to read the cached messages
  fs.readFile(SMSglue.cache(glue.id, 'messages'), 'utf8', (err, data) => {

    // Decrypt the messages and send them back
    var smss = SMSglue.decrypt(data, glue.pass) || [];
    if (smss.length) {
      // console.log('Found SMS cache')
      fetchFilteredSMS(smss);

    // If the array is empty, update the cache from voip.ms and try again
    } else {
      // console.log('DID NOT find SMS cache')
      glue.get((error) => {

        // Read the cached messages one more time
        fs.readFile(SMSglue.cache(glue.id, 'messages'), 'utf8', (err, data) => {

          // Decrypt the messages and send them back (last chance)
          smss = SMSglue.decrypt(data, glue.pass) || [];
          fetchFilteredSMS(smss);

        });
      });
    }
  });   
}

app.actions.send = (params, res) => {
  let glue = new SMSglue(params.token);
  glue.send(params.dst, params.msg, (err, r, body) => {

    if (body = SMSglue.parseBody(body)) {
      res.setHeader('Content-Type', 'application/json');
      res.send({ response: { error: 0, description: 'Success' }});

    } else {
      res.setHeader('Content-Type', 'application/json');
      res.send({ response: { error: 400, description: 'Invalid parameters' }});
    }
  });
}

app.actions.balance = (params, res) => {
  var glue = new SMSglue(params.token);
  glue.balance((err, r, body) => {

    if (body = SMSglue.parseBody(body)) {
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

app.actions.rate = (params, res) => {
  var glue = new SMSglue(params.token);
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
