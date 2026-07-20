#!/bin/sh
set -eu

task=${1:?task id is required}
case "$task" in
  add|subtract|multiply|divide|maximum|clamp|even|average|factorial|square) ;;
  *) printf 'unknown task: %s\n' "$task" >&2; exit 2 ;;
esac

rm -rf .build
mkdir -p .build
javac -d .build src/Calculator.java "eval/${task}Test.java"
java -ea -cp .build "${task}Test"
