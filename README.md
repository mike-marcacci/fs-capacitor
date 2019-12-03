[![Build status](https://travis-ci.org/mike-marcacci/fs-capacitor.svg?branch=master)](https://travis-ci.org/mike-marcacci/fs-capacitor) [![Current version](https://badgen.net/npm/v/fs-capacitor)](https://npm.im/fs-capacitor) ![Supported Node.js versions](https://badgen.net/npm/node/fs-capacitor)

# FS Capacitor

FS Capacitor is a filesystem buffer for finite node streams. It supports simultaneous read/write, and can be used to create multiple independent readable streams, each starting at the beginning of the buffer.

This is useful for file uploads and other situations where you want to avoid delays to the source stream, but have slow downstream transformations to apply:

```js
import fs from "fs";
import http from "http";
import { WriteStream } from "fs-capacitor";

http.createServer((req, res) => {
  const capacitor = new WriteStream();
  const destination = fs.createWriteStream("destination.txt");

  // pipe data to the capacitor
  req.pipe(capacitor);

  // read data from the capacitor
  capacitor
    .createReadStream()
    .pipe(/* some slow Transform streams here */)
    .pipe(destination);

  // read data from the very beginning
  setTimeout(() => {
    capacitor.createReadStream().pipe(/* elsewhere */);

    // you can destroy a capacitor as soon as no more read streams are needed
    // without worrying if existing streams are fully consumed
    capacitor.destroy();
  }, 100);
});
```

It is especially important to use cases like [`graphql-upload`](https://github.com/jaydenseric/graphql-upload) where server code may need to stash earler parts of a stream until later parts have been processed, and needs to attach multiple consumers at different times.

FS Capacitor creates its temporary files in the directory ideneified by `os.tmpdir()` and attempts to remove them:

- after `writeStream.destroy()` has been called and all read streams are fully consumed or destroyed
- before the process exits

Please do note that FS Capacitor does NOT release disk space _as data is consumed_, and therefore is not suitable for use with infinite streams or those larger than the filesystem.

### Ensuring cleanup on termination by process signal

FS Capacitor cleans up all of its temporary files before the process exits, by listening to the [node process's `exit` event](https://nodejs.org/api/process.html#process_event_exit). This event, however, is only emitted when the process is about to exit as a result of either:

- The process.exit() method being called explicitly;
- The Node.js event loop no longer having any additional work to perform.

When the node process receives a `SIGINT`, `SIGTERM`, or `SIGHUP` signal and there is no handler, it will exit without emitting the `exit` event.

Beginning in version 3, fs-capacitor will NOT listen for these signals. Instead, the application should handle these signals according to its own logic and call `process.exit()` when it is ready to exit. This allows the application to implement its own graceful shutdown procedures, such as waiting for a stream to finish.

The following can be added to the application to ensure resources are cleaned up before a signal-induced exit:

```js
function shutdown() {
  // Any sync or async graceful shutdown procedures can be run before exiting…
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);
```

## API

### WriteStream

`WriteStream` inherets all the methods of [`fs.WriteStream`](https://nodejs.org/api/fs.html#fs_class_fs_writestream)

#### `new WriteStream()`

Create a new `WriteStream` instance.

#### `.createReadStream(): ReadStream`

Create a new `ReadStream` instance attached to the `WriteStream` instance.

Calling `.createReadStream()` on a released `WriteStream` will throw a `ReadAfterReleasedError` error.

Calling `.createReadStream()` on a destroyed `WriteStream` will throw a `ReadAfterDestroyedError` error.

As soon as a `ReadStream` ends or is closed (such as by calling `readStream.destroy()`), it is detached from its `WriteStream`.

#### `.release(): void`

Release the `WriteStream`'s claim on the underlying resources. Once called, destruction of underlying resources is performed as soon as all attached `ReadStream`s are removed.

#### `.destroy(error?: ?Error): void`

Destroy the `WriteStream` and all attached `ReadStream`s. If `error` is present, attached `ReadStream`s are destroyed with the same error.

### ReadStream

`ReadStream` inherets all the methods of [`fs.ReadStream`](https://nodejs.org/api/fs.html#fs_class_fs_readstream).
