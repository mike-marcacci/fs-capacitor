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
    this.on("error", error => {
      this.error = error;
    });

    this.ended = this._writeStream.error !== null;
    this.once("end", () => {
      this.ended = true;
    });

    this.open();
  }

  _read(n) {
    // The writer has finished, so the reader can continue uninterupted.
    if (this._writeStream.finished || this._writeStream.closed) {
      return super._read(n);
    }

    // Make sure there's something to read.
    const unread = this._writeStream.bytesWritten - this.bytesRead;
    if (unread === 0) {
      setImmediate(this._read.bind(this, n));
      return;
    }

    // Make sure we don't get ahead of our writer.
    return super._read(Math.min(n, unread));
  }

  _destroy(error, callback) {
    this.fd = null;
    this.emit("close");
    callback(error);
  }

  open() {
    if (!this._writeStream || typeof this._writeStream.fd !== "number") return;

    this.path = this._writeStream.path;
    this.fd = this._writeStream.fd;
    super.open();
  }
}

export class WriteStream extends fs.WriteStream {
  constructor() {
    super("", {
      flags: "w+",
      autoClose: false
    });

    this._readStreams = new Set();

    this.on("open", error => {
      for (let readStream of this._readStreams) {
        readStream.open();
      }
    });

    this.error = null;
    this.on("error", error => {
      this.error = error;

      for (let readStream of this._readStreams) {
        readStream.destroy(error);
      }
    });

    this.finished = false;
    this.once("finish", () => {
      this.finished = true;
    });

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

  _destroy(error, callback) {
    const isOpen = typeof this.fd !== "number";
    if (isOpen) {
      this.once("open", this._destroy.bind(this, error, callback));
      return;
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
    // This is already destroyed.
    if (this.destroyed) {
      return super.destroy(error, callback);
    }

    // Call the callback once destroyed.
    if (typeof callback === "function") {
      this.once("close", callback.bind(this, error));
    }

    // If there is an error, destroy all read streams with the error.
    if (error) {
      super.destroy(error, callback);
      return;
    }

    // All read streams have terminated, so we can destroy this.
    if (this._readStreams.size === 0) {
      super.destroy(error, callback);

      return;
    }

    // Wait until all read streams have terminated before destroying this.
    this._destroyPending = true;
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
}

export default WriteStream;
