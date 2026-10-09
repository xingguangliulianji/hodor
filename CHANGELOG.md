# Changelog

## [1.6.0](https://github.com/huaiminyetnotsleep/hodor/compare/v1.5.0...v1.6.0) (2026-10-09)


### Features

* stage 7 public release readiness — /selfcheck endpoint, d1-console ops SQL pack, release regression suite, docs sync (T07, T10–T12) ([e49c2b2](https://github.com/huaiminyetnotsleep/hodor/commit/e49c2b25bb705d9b0c5474377be22dd9a5fafbbe))

## [1.5.0](https://github.com/huaiminyetnotsleep/hodor/compare/v1.4.0...v1.5.0) (2026-10-08)


### Features

* stage 6 session maintenance — deluser/purgemsg/wipealldata + native topic-delete self-heal (T38-T40) ([50860ab](https://github.com/huaiminyetnotsleep/hodor/commit/50860ab31b1c828ac77056d5dd5c93ac7c5eaa3c))
* stage 6 session maintenance rework — native topic sync, archive, physical delete, wipe deletes all topics (T38-T40) ([3bd70d6](https://github.com/huaiminyetnotsleep/hodor/commit/3bd70d6eeb84e54cb30199b5b3ab6e5b838b895d))

## [1.4.0](https://github.com/huaiminyetnotsleep/hodor/compare/v1.3.0...v1.4.0) (2026-10-08)


### Features

* stage 5 daily management — verify switch, mode, TTL, notes, risk flags (T31-T33, T36-T37) ([7a45886](https://github.com/huaiminyetnotsleep/hodor/commit/7a4588615fa99a11c229c23806ebffb1b6166d73))

## [1.3.0](https://github.com/huaiminyetnotsleep/hodor/compare/v1.2.0...v1.3.0) (2026-09-30)


### Features

* stage 4 security trial — math verification, rate limit, notices, commands, 429 bounds (T18, T27-T30, T34-T35) ([e4a1c85](https://github.com/huaiminyetnotsleep/hodor/commit/e4a1c85a9a0f724fdf8eb3973210628bdd0f8bb3))

## [1.2.0](https://github.com/huaiminyetnotsleep/hodor/compare/v1.1.0...v1.2.0) (2026-09-30)


### Features

* stage 3 chat experience — media relay, welcome, pin, ledger, unbound notice (T22-T26) ([9d728d3](https://github.com/huaiminyetnotsleep/hodor/commit/9d728d33120faaa2b0413b1d5caf9d6eb706af00))

## [1.1.0](https://github.com/huaiminyetnotsleep/hodor/compare/v1.0.0...v1.1.0) (2026-09-30)


### Features

* finalize relay form — clean sendMessage both directions ([85a683b](https://github.com/huaiminyetnotsleep/hodor/commit/85a683b69e8a797395685535241bdf4b08646e53))
* inbound relay via forwardMessage for user identity ([f2b5835](https://github.com/huaiminyetnotsleep/hodor/commit/f2b5835cda703f311aaf227b9eb4d39f20c9223f))
* stage 2 minimal MVP — bidirectional text relay (T13-T17, T19-T21) ([86cf62f](https://github.com/huaiminyetnotsleep/hodor/commit/86cf62face68726783d02eebb6804b783b647344))


### Bug Fixes

* relay via sendMessage after production copyMessage failure ([56fa6af](https://github.com/huaiminyetnotsleep/hodor/commit/56fa6af3a544a9a6453b2776f49a1115819e4a44))

## 1.0.0 (2026-09-30)


### Features

* stage 1 deployment foundation (T01-T06, T08-T09) ([6576936](https://github.com/huaiminyetnotsleep/hodor/commit/6576936eff26c91f7e4654781532d16076bfecbd))
* Workers Builds default-command compatibility via gated postinstall ([825573c](https://github.com/huaiminyetnotsleep/hodor/commit/825573c4fab383c129b2ccdba613285cf0f75edc))


### Bug Fixes

* resolve D1 by account-wide list, not d1 info ([bc81459](https://github.com/huaiminyetnotsleep/hodor/commit/bc814592d45ca6d9151858202e3f29fc0b7bb41a))
