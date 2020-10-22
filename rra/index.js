let broker = require(`${__dirname}/../lib/index`)
let relay = require(`${__dirname}/../lib/relay`)

relay.setCustomResponseHandler(function(req, emit) {

  console.log("#### Got request:", req)

  console.log("#### Handling response")

  emit({ status: 403,
    body: '{\n  "errors" : [ {\n    "status" : 403,\n    "message" : "Download request for repo:path \'dockerdev:foo/bar\' is forbidden for user \'anonymous\'."\n  } ]\n}',
    headers:
     { server: 'nginx',
       date: 'Thu, 22 Oct 2020 09:50:11 GMT',
       'content-type': 'application/json',
       'transfer-encoding': 'chunked',
       connection: 'close',
       vary: 'Accept-Encoding',
       'x-artifactory-id': '54d35a2d83aebf74:-4c63375d:175182f7fa1:-8000',
       'strict-transport-security': 'max-age=15724800; includeSubDomains' } })

})

broker.main({
  port:7342,
  client:true,
  config:{}
});