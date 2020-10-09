import { WriteStream } from "../index";

const capacitor = new WriteStream();

capacitor.once("ready", () => {
  if (!process.send) {
    throw new Error("Must be called in child process");
  }

  process.send(
    {
      path: capacitor["_path"],
    },
    (err: Error | null) => {
      if (err) {
        throw err;
      }
    }
  );
});

process.on("message", (msg) => {
  if (msg.exit) {
    process.exit();
  }
});
