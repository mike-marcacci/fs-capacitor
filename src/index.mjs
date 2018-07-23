import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

export class ReadAfterDestroyedError extends Error {}

export class ReadStream extends fs.ReadStream {
  constructor(writeStream) {
    super("", {});

    this._writeStream = writeStream;

    // Persist terminating events.
    this.error = this._writeStream.error;
    this.addListener("error", error => {
      this.error = error;
    });

    this.open();
  }

  get ended() {
    return this._readableState.ended;
  }

  _read(n) {
    if (typeof this.fd !== "number") {
      return this.once("open", function() {
        this._read(n);
      });
    }

    // The writer has finished, so the reader can continue uninterupted.
    if (this._writeStream.finished || this._writeStream.closed) {
      return super._read(n);
    }

    // Make sure there's something to read.
    const unread = this._writeStream.bytesWritten - this.bytesRead;
    if (unread === 0) {
      const retry = () => {
        this._writeStream.removeListener("finish", retry);
        this._writeStream.removeListener("write", retry);
        this._read(n);
      };

      this._writeStream.addListener("finish", retry);
      this._writeStream.addListener("write", retry);
      return;
    }

    // Make sure we don't get ahead of our writer.
    return super._read(Math.min(n, unread));
  }

  _destroy(error, callback) {
    this.fd = null;
    this.closed = true;
    this.emit("close");
    callback(error);
  }

  open() {
    if (!this._writeStream || typeof this._writeStream.fd !== "number") return;

    this.path = this._writeStream.path;
    this.fd = this._writeStream.fd;
    super.open();
  }

  addListener(type, listener) {
    if (type === "error" && this.error) {
      process.nextTick(listener.bind(this, this.error));
      return this;
    }

    if (type === "close" && this.closed) {
      process.nextTick(listener.bind(this));
      return this;
    }

    if (type === "end" && this.ended) {
      process.nextTick(listener.bind(this));
      return this;
    }

    return super.addListener(type, listener);
  }

  on(type, listener) {
    return this.addListener(type, listener);
  }
}

export class WriteStream extends fs.WriteStream {
  constructor() {
    super("", {
      flags: "w+",
      autoClose: false
    });

    this._readStreams = new Set();

    this.addListener("open", error => {
      for (let readStream of this._readStreams) {
        readStream.open();
      }
    });

    this.error = null;

    this._cleanupSync = () => {
      process.removeListener("exit", this._cleanupSync);
      process.removeListener("SIGINT", this._cleanupSync);

      if (typeof this.fd === "number") {
        try {
          fs.closeSync(this.fd);
        } catch (error) {
          // An error here probably means the fd was already closed, but we can
          // still try to unlink the file.
        }
      }

      try {
        fs.unlinkSync(this.path);
      } catch (error) {
        // If we are unable to unlink the file, the operating system will clean up
        //  on next restart, since we use store thes in `os.tmpdir()`
      }
    };
  }

  get finished() {
    return this._writableState.finished;
  }

  open() {
    if (this.fd) {
      super.open();
      return;
    }

    // generage a random tmp path
    crypto.randomBytes(16, (error, buffer) => {
      if (error) {
        if (this.autoClose) {
          this.destroy(error);
        }
        return;
      }

      this.path = path.join(
        os.tmpdir(),
        `capacitor-${buffer.toString("hex")}.tmp`
      );

      // create the file
      fs.open(this.path, "wx+", (error, fd) => {
        if (error) {
          if (this.autoClose) {
            this.destroy(error);
          }
          return;
        }

        // cleanup when our stream closes or when the process exits
        process.addListener("exit", this._cleanupSync);
        process.addListener("SIGINT", this._cleanupSync);

        super.open();
      });
    });
  }

  _write(data, encoding, callback) {
    super._write(data, encoding, error => {
      process.nextTick(() => this.emit("write"));
      callback(error);
    });
  }

  _destroy(error, callback) {
    const isOpen = typeof this.fd !== "number";
    if (isOpen) {
      this.once("open", this._destroy.bind(this, error, callback));
      return;
    }

    if (this.closed) {
      return callback(error);
    }

    process.removeListener("exit", this._cleanupSync);
    process.removeListener("SIGINT", this._cleanupSync);

    const unlink = error => {
      fs.unlink(this.path, unlinkError => {
        // If we are unable to unlink the file, the operating system will
        // clean up on next restart, since we use store thes in `os.tmpdir()`

        if (!unlinkError) {
          this.fd = null;
          this.closed = true;
          this.emit("close");
        }

        callback(unlinkError || error);
      });
    };

    if (typeof this.fd === "number") {
      fs.close(this.fd, closeError => {
        // An error here probably means the fd was already closed, but we can
        // still try to unlink the file.

        unlink(closeError || error);
      });

      return;
    }

    unlink(error);
  }

  destroy(error, callback) {
    if (error) {
      this.error = error;
    }

    // This is already destroyed.
    if (this.destroyed) {
      return super.destroy(error, callback);
    }

    // Call the callback once destroyed.
    if (typeof callback === "function") {
      this.once("close", callback.bind(this, error));
    }

    // All read streams have terminated, so we can destroy this.
    if (this._readStreams.size === 0) {
      super.destroy(error, callback);
      return;
    }

    // Wait until all read streams have terminated before destroying this.
    this._destroyPending = true;

    // If there is an error, destroy all read streams with the error.
    if (error) {
      for (let readStream of this._readStreams) {
        readStream.destroy(error);
      }
    }
  }

  createReadStream() {
    if (this.destroyed) {
      throw new ReadAfterDestroyedError(
        "Cannot create read stream from destroyed capacitor."
      );
    }

    const readStream = new ReadStream(this);
    this._readStreams.add(readStream);

    const remove = () => {
      this._deleteReadStream(readStream);
      readStream.removeListener("end", remove);
      readStream.removeListener("close", remove);
    };

    readStream.addListener("end", remove);
    readStream.addListener("close", remove);

    return readStream;
  }

  _deleteReadStream(readStream) {
    if (this._readStreams.delete(readStream) && this._destroyPending) {
      this.destroy();
    }
  }

  addListener(type, listener) {
    if (type === "error" && this.error) {
      process.nextTick(listener.bind(this, this.error));
      return this;
    }

    if (type === "close" && this.closed) {
      process.nextTick(listener.bind(this));
      return this;
    }

    if (type === "finish" && this.finished) {
      process.nextTick(listener.bind(this));
      return this;
    }

    return super.addListener(type, listener);
  }

  on(type, listener) {
    return this.addListener(type, listener);
  }
}

export default WriteStream;
