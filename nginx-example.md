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
