FS Capacitor is a filesystem-bufferred, passthrough stream that buffers indefinitely rather than propagate backpressure from downstream consumers.

This is useful for file uploads and other situations where you want to avoid delays to the source stream, but have slow downstream transformations to apply:

```js
import fs from "fs";
import http from "http";
import Capacitor from "fs-capacitor";

http.createServer((req, res) => {
  const capacitor = new Capacitor();
  const destination = fs.createReadStream("destination.txt");

  req
    .pipe(capacitor)
    // ... some slow Transform streams here ...
    .pipe(destination);
});
```

It is especially important to use cases like [apollo-upload-server](https://github.com/jaydenseric/apollo-upload-server/) where server code may need to stash earler parts of a stream until later parts have been processed.

FS Capacitor creates its temporary files in the directory ideneified by `os.tmpdir()` and attempts to remove them:

- as soon as the capacitor stream is fully consumed
- as soon as `capacitor.destroy()` is called
- before the process exits

Please do note that FS Capacitor does NOT release disk space *as data is consumed*, and therefore is not suitable for use in infinite streams or those larger than the filesystem.
