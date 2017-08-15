# SMSglue

For subscribers of VoIP.ms who use Acrobits Softphone or Groundwire, SMSglue will enable SMS text messaging.

## Quick Start

```
$ npm install smsglue
$ node
> require('smsglue').listen(5000)
```

Then point your browser to localhost on port 5000.

## Notes

For this to be useful, you'll want to create a reverse proxy with a 
proper domain and https encryption. It may also be a good idea to
strip sensitive information from your access logs (see example below),
as there will be access tokens and messages crossing the wire as GET
requests. 

## nginx Example

```conf
http {
  ...

  log_format filter '$remote_addr - $remote_user [$time_local] "$req" $status $body_bytes_sent "$http_referer" "$http_user_agent"';

  server {
  ...

    location {
      ...

      # Strip everything after hyphen "-" in log request
      set $req $request;
      if ($req ~ (.+)\-(.*)) { set $req $1; }
      access_log access.log filter;
    }
  }
}
```

## Customization

It's possible to append custom HTML content to the end of the index.html
page by setting an environment variable named `BEFORE_CLOSING_BODY_TAG`.
For example, this can be used to include a footer and Google Analytics.
