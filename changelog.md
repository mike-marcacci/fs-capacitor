# fs-capacitor changelog

## 1.0.0

- Initial release.

### 1.0.1

- Use default fs flags and mode

## 2.0.0

- Updated dependencies.
- Add tests for special stream scenarios.
- BREAKING: Remove special handling of terminating events, see [jaydenseric/graphql-upload#131](https://github.com/jaydenseric/graphql-upload/issues/131)

### 2.0.1

- Updated dependencies.
- Move configs out of package.json
- Use `wx` file flag instead of default `w` (thanks to @mattbretl via #8)

### 2.0.2

- Updated dev dependencies.
- Fix mjs structure to work with node v12.
- Fix a bug that would pause consumption of read streams until completion. (thanks to @Nikosmonaut's investigation in #9).

### 2.0.3

- Emit write event _after_ bytes have been written to the filesystem.

### 2.0.4

- Restore native module support in node < 12.
