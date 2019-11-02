import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import rs from "readable-stream";

// Because we target .mjs files and this dependency is commonjs, we can't use
// named exports. Instead, we'll just destructure the object.
const { Readable, Writable } = rs;

let haveCheckedSignalListeners = false;
function checkSignalListeners() {
  haveCheckedSignalListeners = true;

  if (!process.listeners("SIGINT").length)
    process.emitWarning(
      "There are no listeners for SIGINT. If your application receives a SIGINT signal, it is possible that some temporary files will not be cleaned up. Please see https://github.com/mike-marcacci/fs-capacitor#ensuring-cleanup-on-termination-by-process-signal"
    );

  if (!process.listeners("SIGTERM").length)
    process.emitWarning(
      "There are no listeners for SIGTERM. If your application receives a SIGTERM signal, it is possible that some temporary files will not be cleaned up. Please see https://github.com/mike-marcacci/fs-capacitor#ensuring-cleanup-on-termination-by-process-signal"
    );

  if (!process.listeners("SIGHUP").length)
    process.emitWarning(
      "There are no listeners for SIGHUP. If your application receives a SIGHUP signal, it is possible that some temporary files will not be cleaned up. Please see https://github.com/mike-marcacci/fs-capacitor#ensuring-cleanup-on-termination-by-process-signal"
    );
}

export class ReadAfterDestroyedError extends Error {}

export class ReadStream extends Readable {
  constructor(writeStream, name) {
    super({ autoDestroy: true });

    this._pos = 0;
    this._writeStream = writeStream;

    this.name = name;
  }

  _read(n) {
    if (this.destroyed) return;

    if (typeof this._writeStream._fd !== "number") {
      this._writeStream.once("ready", () => this._read(n));
      return;
    }

    // Using `allocUnsafe` here is OK because we return a slice the length of
    // `bytesRead`, and discard the rest. This prevents node from having to zero
    // out the enture allocation first.
    let buf = Buffer.allocUnsafe(n);
    fs.read(this._writeStream._fd, buf, 0, n, this._pos, (error, bytesRead) => {
      if (error) this.destroy(error);

      // Push any read bytes into the local stream buffer.
      if (bytesRead) {
        this._pos += bytesRead;
        this.push(buf.slice(0, bytesRead));
        return;
      }

      // If there were no more bytes to read and the write stream is finished,
      // than this stream has reached the end.
      if (this._writeStream._writableState.finished) {
        this.push(null);
        return;
      }

      // Otherwise, wait for the write stream to add more data or finish.
      const retry = () => {
        this._writeStream.removeListener("finish", retry);
        this._writeStream.removeListener("write", retry);
        this._read(n);
      };

      this._writeStream.addListener("finish", retry);
      this._writeStream.addListener("write", retry);
    });
  }
}

export class WriteStream extends Writable {
  constructor() {
    if (!haveCheckedSignalListeners) checkSignalListeners();

    super({ autoDestroy: false });

    this._pos = 0;
    this._readStreams = new Set();

    this._cleanupSync = () => {
      process.removeListener("exit", this._cleanupSync);

      if (typeof this._fd === "number")
        try {
          fs.closeSync(this._fd);
        } catch (error) {
          // An error here probably means the fd was already closed, but we can
          // still try to unlink the file.
        }

      try {
        fs.unlinkSync(this._path);
      } catch (error) {
        // If we are unable to unlink the file, the operating system will clean
        // up on next restart, since we use store thes in `os.tmpdir()`
      }
    };

    // Generate a random filename.
    crypto.randomBytes(16, (error, buffer) => {
      if (error) {
        this.destroy(error);
        return;
      }

      this._path = path.join(
        os.tmpdir(),
        `capacitor-${buffer.toString("hex")}.tmp`
      );

      // Create a file in the OS's temporary files directory.
      fs.open(this._path, "wx+", 0o600, (error, fd) => {
        if (error) {
          this.destroy(error);
          return;
        }

        // Cleanup when the process exits or is killed.
        process.addListener("exit", this._cleanupSync);

        this._fd = fd;
        this.emit("ready");
      });
    });
  }

  _final(callback) {
    if (typeof this._fd !== "number") {
      this.once("ready", () => this._final(callback));
      return;
    }
    callback();
  }

  _write(chunk, encoding, callback) {
    if (typeof this._fd !== "number") {
      this.once("ready", () => this._write(chunk, encoding, callback));
      return;
    }

    fs.write(this._fd, chunk, 0, chunk.length, this._pos, error => {
      if (error) {
        callback(error);
        return;
      }

      // It's safe to increment `this._pos` after flushing to the filesystem
      // because node streams ensure that only one `_write()` is active at a
      // time. If this assumption is broken, the behavior of this library is
      // undefined, regardless of where this is incremented. Relocating this
      // to increment syncronously would result in correct file contents, but
      // the out-of-order writes would still open the potential for read streams
      // to scan positions that have not yet been written.
      this._pos += chunk.length;
      this.emit("write");
      callback();
    });
  }

  _destroy(error, callback) {
    if (typeof this._fd !== "number") {
      this.once("ready", () => this._destroy(error, callback));
      return;
    }

    // Wait until all read streams have terminated before destroying this.
    this._destroyPending = () => {
      process.removeListener("exit", this._cleanupSync);

      const unlink = error => {
        fs.unlink(this._path, unlinkError => {
          // If we are unable to unlink the file, the operating system will
          // clean up on next restart, since we use store thes in `os.tmpdir()`
          this._fd = null;
          callback(unlinkError || error);
        });
      };

      if (typeof this._fd === "number")
        fs.close(this._fd, closeError => {
          // An error here probably means the fd was already closed, but we can
          // still try to unlink the file.

          unlink(closeError || error);
        });
      else callback(error);
    };

    // All read streams have terminated, so we can destroy this.
    if (this._readStreams.size === 0) this._destroyPending();
    else if (error)
      // If there is an error, destroy all read streams with the error.
      for (let readStream of this._readStreams) readStream.destroy(error);
  }

  createReadStream(name) {
    if (this.destroyed)
      throw new ReadAfterDestroyedError(
        "A ReadStream cannot be created from a destroyed WriteStream."
      );

    const readStream = new ReadStream(this, name);
    this._readStreams.add(readStream);

    const remove = () => {
      this._readStreams.delete(readStream);

      if (this._destroyPending && this._readStreams.size === 0)
        this._destroyPending();

      readStream.removeListener("end", remove);
      readStream.removeListener("close", remove);
    };

    readStream.addListener("end", remove);
    readStream.addListener("close", remove);

    return readStream;
  }
}

export default WriteStream;
