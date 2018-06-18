module.exports = {
  comments: false,
  presets: [
    [
      "@babel/preset-env",
      {
        targets: {
          node: "8.5"
        },
        modules: process.env.BABEL_ESM ? false : "commonjs"
      }
    ]
  ]
};
