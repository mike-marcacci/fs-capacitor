import "leaked-handles";

import fs from "fs";
import WriteStream, { ReadAfterDestroyedError } from ".";
import stream from "stream";
import t from "tap";

const streamToString = stream =>
  new Promise((resolve, reject) => {
    let data = "";
    stream
      .on("error", reject)
      .on("data", chunk => {
        data += chunk;
      })
      .on("end", () => resolve(data));
  });

const waitForBytesWritten = (stream, bytes, resolve) => {
  if (stream.bytesWritten >= bytes) {
    resolve();
    return;
  }

  setImmediate(() => waitForBytesWritten(stream, bytes, resolve));
};

t.test("Capacitor", async t => {
  let data = "";
  const source = new stream.Readable({
    read() {}
  });

  // Create a new capacitor and read stream before any data has been written
  let capacitor1;
  let capacitor1Stream1;
  await t.test(
    "can add a read stream before any data has been written",
    async t => {
      capacitor1 = new WriteStream();
      t.strictSame(
        capacitor1._readStreams.size,
        0,
        "should start with 0 read streams"
      );
      capacitor1Stream1 = capacitor1.createReadStream();
      t.strictSame(
        capacitor1._readStreams.size,
        1,
        "should attach a new read stream before receiving data"
      );

      await t.test("creates a temporary file", async t => {
        t.plan(3);
        await new Promise(resolve => capacitor1.on("open", resolve));
        t.type(capacitor1.path, "string", "capacitor1.path should be a string");
        t.type(capacitor1.fd, "number", "capacitor1.fd should be a number");
        t.ok(fs.existsSync(capacitor1.path), "creates a temp file");
      });
    }
  );

  // Pipe data to the capacitor
  source.pipe(capacitor1);

  // Add the first chunk of data (without any read streams)
  const chunk1 = "1".repeat(100);
  source.push(chunk1);
  data += chunk1;

  // Wait until this chunk has been written to the buffer
  await new Promise(resolve => waitForBytesWritten(capacitor1, 100, resolve));

  // Create a new stream after some data has been written
  let capacitor1Stream2;
  await t.test("can add a read stream after data has been written", async t => {
    capacitor1Stream2 = capacitor1.createReadStream();
    t.strictSame(
      capacitor1._readStreams.size,
      2,
      "should attach a new read stream after first write"
    );
  });

  // Add a second chunk of data
  const chunk2 = "2".repeat(100);
  source.push(chunk2);
  data += chunk2;

  // Wait until this chunk has been written to the buffer
  await new Promise(resolve => waitForBytesWritten(capacitor1, 200, resolve));

  // End the source & wait until capacitor is finished
  const finished = new Promise(resolve => capacitor1.once("finish", resolve));
  source.push(null);
  await finished;

  // Create a new stream after the source has ended
  let capacitor1Stream3;
  await t.test(
    "can create a read stream after the source has ended",
    async t => {
      capacitor1Stream3 = capacitor1.createReadStream();
      t.strictSame(
        capacitor1._readStreams.size,
        3,
        "should attach new read streams after end"
      );
    }
  );

  // Consume capacitor1Stream2
  let result1;
  await t.test("streams complete data to a read stream", async t => {
    result1 = await streamToString(capacitor1Stream2);
    t.strictSame(
      capacitor1Stream2.ended,
      true,
      "should mark read stream as ended"
    );
    t.strictSame(result1, data, "should stream complete data");
    t.strictSame(
      capacitor1._readStreams.size,
      2,
      "should detach an ended read stream"
    );
  });

  // Destroy capacitor1Stream1
  await t.test("can destroy a read stream", async t => {
    await new Promise(resolve => {
      capacitor1Stream1.once("error", resolve);
      capacitor1Stream1.destroy(new Error("test"));
    });
    t.strictSame(
      capacitor1Stream1.destroyed,
      true,
      "should mark read stream as destroyed"
    );
    t.type(
      capacitor1Stream1.error,
      Error,
      "should store an error on read stream"
    );
    t.strictSame(
      capacitor1._readStreams.size,
      1,
      "should detach a destroyed read stream"
    );
  });

  // Destroy the capacitor (without an error)
  await t.test("can delay destruction of a capacitor", async t => {
    capacitor1.destroy(null);

    t.strictSame(
      capacitor1.destroyed,
      false,
      "should not destroy while read streams exist"
    );
    t.strictSame(
      capacitor1._destroyPending,
      true,
      "should mark for future destruction"
    );
  });

  // Destroy capacitor1Stream2
  await t.test("destroys capacitor once no read streams exist", async t => {
    const readStreamDestroyed = new Promise(resolve =>
      capacitor1Stream3.on("close", resolve)
    );
    const capacitorDestroyed = new Promise(resolve =>
      capacitor1.on("close", resolve)
    );
    capacitor1Stream3.destroy(null);
    await readStreamDestroyed;
    t.strictSame(
      capacitor1Stream3.destroyed,
      true,
      "should mark read stream as destroyed"
    );
    t.strictSame(
      capacitor1Stream3.error,
      null,
      "should not store an error on read stream"
    );
    t.strictSame(
      capacitor1._readStreams.size,
      0,
      "should detach a destroyed read stream"
    );
    await capacitorDestroyed;
    t.strictSame(capacitor1.closed, true, "should mark capacitor as closed");
    t.strictSame(capacitor1.fd, null, "should set fd to null");
    t.strictSame(
      capacitor1.destroyed,
      true,
      "should mark capacitor as destroyed"
    );
    t.notOk(fs.existsSync(capacitor1.path), "removes its temp file");
  });

  // Try to create a new read stream
  await t.test("cannot create a read stream after destruction", async t => {
    t.throws(
      () => capacitor1.createReadStream(),
      ReadAfterDestroyedError,
      "should not create a read stream once destroyed"
    );
  });

  const capacitor2 = new WriteStream();
  const capacitor2Stream1 = capacitor2.createReadStream();
  const capacitor2Stream2 = capacitor2.createReadStream();

  const capacitor2ReadStream1Destroyed = new Promise(resolve =>
    capacitor2Stream1.on("close", resolve)
  );
  const capacitor2Destroyed = new Promise(resolve =>
    capacitor2.on("close", resolve)
  );

  capacitor2Stream1.destroy();
  await capacitor2ReadStream1Destroyed;

  await t.test("propagates errors to attached read streams", async t => {
    capacitor2.destroy();
    await new Promise(resolve => setImmediate(resolve));
    t.strictSame(
      capacitor2Stream2.destroyed,
      false,
      "should not immediately mark attached read streams as destroyed"
    );

    capacitor2.destroy(new Error("test"));
    await capacitor2Destroyed;

    t.type(capacitor2.error, Error, "should store an error on capacitor");
    t.strictSame(
      capacitor2.destroyed,
      true,
      "should mark capacitor as destroyed"
    );
    t.type(
      capacitor2Stream2.error,
      Error,
      "should store an error on attached read streams"
    );
    t.strictSame(
      capacitor2Stream2.destroyed,
      true,
      "should mark attached read streams as destroyed"
    );
    t.strictSame(
      capacitor2Stream1.error,
      null,
      "should not store an error on detached read streams"
    );
  });

  await t.test("calls new listeners with past terminating events", async t => {
    t.type(
      await new Promise(resolve => capacitor2.on("error", resolve)),
      Error,
      "WriteStream error"
    );
    await t.resolves(
      new Promise(resolve => capacitor2.on("close", resolve)),
      "WriteStream close"
    );
    await t.resolves(
      new Promise(resolve => capacitor1.on("finish", resolve)),
      "WriteStream finish"
    );
    t.type(
      await new Promise(resolve => capacitor2Stream2.on("error", resolve)),
      Error,
      "ReadStream error"
    );
    await t.resolves(
      new Promise(resolve => capacitor2Stream2.on("close", resolve)),
      "ReadStream close"
    );
    await t.resolves(
      new Promise(resolve => capacitor1Stream2.on("end", resolve)),
      "ReadStream end"
    );
  });
});
