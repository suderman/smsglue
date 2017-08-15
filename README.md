# SMSglue

For subscribers of voip.ms who use Acrobits Softphone or Groundwire, SMSglue will enable SMS text messaging.

## Installation

```
npm install smsglue
```

## Usage
```
$ node
> require('smsglue').listen(5000)
```

Then point browser to localhost on port 5000.

Note: for this to be useful, you'll want to create a reverse proxy with
a proper domain and https encryption.
