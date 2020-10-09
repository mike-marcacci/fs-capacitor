import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { Readable, ReadableOptions, Writable, WritableOptions } from "stream";

export class ReadAfterDestroyedError extends Error {}
export class ReadAfterReleasedError extends Error {}

export interface ReadStreamOptions {
  highWaterMark?: ReadableOptions["highWaterMark"];
  encoding?: ReadableOptions["encoding"];
}

export class ReadStream extends Readable {
  private _pos: number = 0;
  private _writeStream: WriteStream;

  constructor(writeStream: WriteStream, options?: ReadStreamOptions) {
    super({
      highWaterMark: options?.highWaterMark,
      encoding: options?.encoding,
      autoDestroy: true,
    });
    this._writeStream = writeStream;
  }

  _read(n: number): void {
    if (this.destroyed) return;

    if (typeof this._writeStream["_fd"] !== "number") {
      this._writeStream.once("ready", () => this._read(n));
      return;
    }

    // Using `allocUnsafe` here is OK because we return a slice the length of
    // `bytesRead`, and discard the rest. This prevents node from having to zero
    // out the entire allocation first.
    const buf = Buffer.allocUnsafe(n);
    fs.read(
      this._writeStream["_fd"],
      buf,
      0,
      n,
      this._pos,
      (error, bytesRead) => {
        if (error) this.destroy(error);

        // Push any read bytes into the local stream buffer.
        if (bytesRead) {
          this._pos += bytesRead;
          this.push(buf.slice(0, bytesRead));
          return;
        }

        // If there were no more bytes to read and the write stream is finished,
        // than this stream has reached the end.
        if (
          ((this._writeStream as any) as {
            _writableState: { finished: boolean };
          })._writableState.finished
        ) {
          this.push(null);
          return;
        }

        // Otherwise, wait for the write stream to add more data or finish.
        const retry = (): void => {
          this._writeStream.removeListener("finish", retry);
          this._writeStream.removeListener("write", retry);
          this._read(n);
        };

        this._writeStream.addListener("finish", retry);
        this._writeStream.addListener("write", retry);
      }
    );
  }
}

export interface WriteStreamOptions {
  highWaterMark?: WritableOptions["highWaterMark"];
  defaultEncoding?: WritableOptions["defaultEncoding"];
}

type File = {
  fd: number;
  path: string;
};

const cleanupSync = (file: File): void => {
  try {
    fs.closeSync(file.fd);
  } catch (error) {
    // An error here probably means the fd was already closed, but we can
    // still try to unlink the file.
  }

  try {
    fs.unlinkSync(file.path);
  } catch (error) {
    // If we are unable to unlink the file, the operating system will clean
    // up on next restart, since we store these in `os.tmpdir()`.
  }
};

// Set of functions to call on exit. Each function should be a call to cleanupSync.
const cleanupCalls = new Set<() => void>();

// Returns a function that calls cleanupSync.
// To prevent leaks, the resulting function only holds references to the File object.
const makeCleanupFn = (file: File): (() => void) => {
  const fn = (): void => {
    cleanupSync(file);

    // remove ourselves from set of functions to call
    cleanupCalls.delete(fn);
  };
  return fn;
};

let exitListenerRegistered = false;

const registerExitListener = (): void => {
  if (exitListenerRegistered) {
    return;
  }

  process.addListener("exit", function fsCapacitorCleanup() {
    for (const fn of cleanupCalls) {
      try {
        fn();
      } catch (err) {
        // keep calling other cleanup functions
      }
    }
  });
  exitListenerRegistered = true;
};

export class WriteStream extends Writable {
  private _fd: null | number = null;
  private _path: null | string = null;
  private _pos: number = 0;
  private _readStreams: Set<ReadStream> = new Set();
  private _released: boolean = false;
  private _cleanup: null | (() => void) = null;

  // This is used by tests
  private static _cleanupCalls = cleanupCalls;

  constructor(options?: WriteStreamOptions) {
    super({
      highWaterMark: options?.highWaterMark,
      defaultEncoding: options?.defaultEncoding,
      autoDestroy: false,
    });

    // Generate a random filename.
    crypto.randomBytes(16, (error, buffer) => {
      if (error) {
        this.destroy(error);
        return;
      }

      const filePath = path.join(
        os.tmpdir(),
        `capacitor-${buffer.toString("hex")}.tmp`
      );
      this._path = filePath;

      // Create a file in the OS's temporary files directory.
      fs.open(filePath, "wx+", 0o600, (error, fd) => {
        if (error) {
          this.destroy(error);
          return;
        }

        // Create a cleanup function that holds no references besides the absolutely necessary ones.
        this._cleanup = makeCleanupFn({ fd, path: filePath });

        // Add this to the list of calls to make on exit.
        cleanupCalls.add(this._cleanup);

        // Register exit listener if none has been registered yet
        registerExitListener();

        this._fd = fd;
        this.emit("ready");
      });
    });
  }

  _final(callback: (error?: null | Error) => any): void {
    if (typeof this._fd !== "number") {
      this.once("ready", () => this._final(callback));
      return;
    }
    callback();
  }

  _write(
    chunk: Buffer,
    encoding: string,
    callback: (error?: null | Error) => any
  ): void {
    if (typeof this._fd !== "number") {
      this.once("ready", () => this._write(chunk, encoding, callback));
      return;
    }

    fs.write(this._fd, chunk, 0, chunk.length, this._pos, (error) => {
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

  release(): void {
    this._released = true;
    if (this._readStreams.size === 0) this.destroy();
  }

  _destroy(
    error: undefined | null | Error,
    callback: (error?: null | Error) => any
  ): void {
    const fd = this._fd;
    const path = this._path;
    if (typeof fd !== "number" || typeof path !== "string") {
      this.once("ready", () => this._destroy(error, callback));
      return;
    }

    // Close the file descriptor.
    fs.close(fd, (closeError) => {
      // An error here probably means the fd was already closed, but we can
      // still try to unlink the file.
      fs.unlink(path, (unlinkError) => {
        // If we are unable to unlink the file, the operating system will
        // clean up on next restart, since we use store thes in `os.tmpdir()`
        this._fd = null;

        // We avoid removing this until now in case an exit occurs while
        // asynchronously cleaning up.
        if (this._cleanup) {
          cleanupCalls.delete(this._cleanup);

          // ensure there are no more references to cleanup function so it can
          // be garbage collected
          this._cleanup = null;
        }
        callback(unlinkError || closeError || error);
      });
    });

    // Destroy all attached read streams.
    for (const readStream of this._readStreams)
      readStream.destroy(error || undefined);
  }

  createReadStream(options?: ReadStreamOptions): ReadStream {
    if (this.destroyed)
      throw new ReadAfterDestroyedError(
        "A ReadStream cannot be created from a destroyed WriteStream."
      );

    if (this._released)
      throw new ReadAfterReleasedError(
        "A ReadStream cannot be created from a released WriteStream."
      );

    const readStream = new ReadStream(this, options);
    this._readStreams.add(readStream);

    const remove = (): void => {
      readStream.removeListener("close", remove);
      this._readStreams.delete(readStream);

      if (this._released && this._readStreams.size === 0) {
        this.destroy();
      }
    };

    readStream.addListener("close", remove);

    return readStream;
  }
}

export default {
  WriteStream,
  ReadStream,
  ReadAfterDestroyedError,
  ReadAfterReleasedError,
};
