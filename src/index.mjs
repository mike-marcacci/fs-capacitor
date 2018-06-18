"use strict";

import fs from "fs";
import os from "os";
import { join } from "path";
import crypto from "crypto";
import { WriteStream, ReadStream } from "fs";

const READER_EVENT_TYPES = ["close", "data", "end", "error", "readable"];

class Reader extends ReadStream {
  constructor(writer) {
    super("", {});
    this._writer = writer;
  }

  _read(n) {
    // The writer has finished, so the reader can continue uninterupted.
    if (this._writer.finished) {
      return super._read(n);
    }

    // Make sure there's something to read.
    const unread = this._writer.bytesWritten - this.bytesRead;
    if (unread === 0) {
      setImmediate(this._read.bind(this, n));
      return;
    }

    // Make sure we don't get ahead of our writer.
    return super._read(Math.min(n, unread));
  }

  open() {
    if (!this._writer || typeof this._writer.fd !== "number") {
      return;
    }

    this.path = this._writer.path;
    this.fd = this._writer.fd;
    super.open();
  }
}

export default class Capacitor extends WriteStream {
  constructor() {
    super("", {
      flags: "w+",
      autoClose: false
    });

    this._reader = new Reader(this);
    this.on("open", () => this._reader.open());
    this.on("finish", () => {
      this.finished = true;
    });
    this.on("end", () => {
      this.ended = true;
    });
    this.on("error", err => {
      this.error = err;
    });
  }

  open() {
    if (this.fd) {
      super.open();
      return;
    }

    // generage a random tmp path
    crypto.randomBytes(48, (err, buffer) => {
      if (err) {
        if (this.autoClose) {
          this.destroy();
        }
        this.emit("error", err);
        return;
      }

      this.path = join(os.tmpdir(), `capacitor-${buffer.toString("hex")}.tmp`);

      // create the file
      fs.open(this.path, "wx+", (err, fd) => {
        if (err) {
          if (this.autoClose) {
            this.destroy();
          }
          this.emit("error", err);
          return;
        }

        const cleanupSync = () => {
          this._reader.off("close", cleanupAsync);
          process.off("exit", cleanupSync);
          process.off("SIGINT", cleanupSync);

          if (typeof this.fd === "number") {
            try {
              fs.closeSync(this.fd);
            } catch (err) {
              // An error here probably means the fd was already closed,
              // but we can still try to unlink the file.
            }
          }

          try {
            fs.unlinkSync(this.path);
          } catch (err) {
            // If we are unable to unlink the file, the operating
            // system will clean up on next restart, since we use
            // store thes in `os.tmpdir()`
          }
        };

        const cleanupAsync = () => {
          this._reader.off("close", cleanupAsync);
          process.off("exit", cleanupSync);
          process.off("SIGINT", cleanupSync);

          const unlink = () => {
            fs.unlink(this.path, err => {
              // If we are unable to unlink the file, the operating
              // system will clean up on next restart, since we use
              // store thes in `os.tmpdir()`
            });
          };

          if (typeof this.fd === "number") {
            fs.close(this.fd, err => {
              // An error here probably means the fd was already closed,
              // but we can still try to unlink the file.

              unlink();
            });

            return;
          }

          unlink();
        };

        // cleanup when our stream closes or when the process exits
        this._reader.on("close", cleanupAsync);
        process.on("exit", cleanupSync);
        process.on("SIGINT", cleanupSync);

        super.open();
      });
    });
  }

  // Handle ReadStream + WriteStream Methods
  // ---------------------------------------

  destroy(err, callback) {
    if (err) {
      this._reader.destroy(err, callback);
    } else {
      super.destroy(err, callback);
    }
  }

  // Proxy ReadStream Methods
  // ------------------------

  isPaused(...args) {
    return this._reader.isPaused(...args);
  }

  pause(...args) {
    return this._reader.pause(...args);
  }

  pipe(...args) {
    return this._reader.pipe(...args);
  }

  read(...args) {
    return this._reader.read(...args);
  }

  resume(...args) {
    return this._reader.resume(...args);
  }

  setEncoding(...args) {
    return this._reader.setEncoding(...args);
  }

  unpipe(...args) {
    return this._reader.unpipe(...args);
  }

  unshift(...args) {
    return this._reader.unshift(...args);
  }

  bytesRead(...args) {
    return this._reader.bytesRead(...args);
  }

  // Proxy ReadStream Properties
  // ---------------------------

  get readableHighWaterMark() {
    return this._reader.readableHighWaterMark;
  }

  set readableHighWaterMark(n) {
    return (this._reader.readableHighWaterMark = n);
  }

  get readableLength() {
    return this._reader.readableLength;
  }

  set readableLength(n) {
    return (this._reader.readableLength = n);
  }

  // Handle EventEmitter Methods
  // ---------------------------

  on(type, listener) {
    return this.addListener(type, listener);
  }

  off(type, listener) {
    return this.removeListener(type, listener);
  }

  emit(type, ...args) {
    if (type === "close") {
      return;
    }

    if (READER_EVENT_TYPES.includes(type)) {
      return this._reader.emit(type, ...args);
    }

    return super.emit(type, ...args);
  }

  addListener(type, listener) {
    if (type === "end" && this.ended) {
      process.nextTick(listener.bind(this));
      return this;
    }

    if (type === "finish" && this.finished) {
      process.nextTick(listener.bind(this));
      return this;
    }

    if (type === "error" && this.error) {
      process.nextTick(listener.bind(this, this.error));
      return this;
    }

    if (READER_EVENT_TYPES.includes(type)) {
      this._reader.addListener(type, listener);
      return this;
    }

    return super.addListener(type, listener);
  }

  listeners(type) {
    if (READER_EVENT_TYPES.includes(type)) {
      return this._reader.listeners(type);
    }

    return super.listeners(type);
  }

  eventNames() {
    return [...this._reader.eventNames(), ...super.eventNames()];
  }

  rawListeners(type) {
    if (READER_EVENT_TYPES.includes(type)) {
      return this._reader.rawListeners(type);
    }

    return super.rawListeners(type);
  }

  listenerCount(type) {
    if (READER_EVENT_TYPES.includes(type)) {
      return this._reader.listenerCount(type);
    }

    return super.listenerCount(type);
  }

  removeListener(type, listener) {
    if (READER_EVENT_TYPES.includes(type)) {
      this._reader.removeListener(type, listener);
      return this;
    }

    return super.removeListener(type, listener);
  }

  getMaxListeners() {
    return Math.min(this._reader.getMaxListeners(), super.getMaxListeners());
  }

  prependListener(type, listener) {
    if (READER_EVENT_TYPES.includes(type)) {
      this._reader.prependListener(type, listener);
      return this;
    }

    return super.prependListener(type, listener);
  }

  setMaxListeners(n) {
    this._reader.setMaxListeners(n);
    return super.setMaxListeners(n);
  }

  removeAllListeners() {
    this._reader.removeAllListeners();
    return super.removeAllListeners();
  }

  prependOnceListener(type, listener) {
    if (READER_EVENT_TYPES.includes(type)) {
      this._reader.prependOnceListener(type, listener);
      return this;
    }

    return super.prependOnceListener(type, listener);
  }
}
