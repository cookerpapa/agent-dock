#!/bin/sh
set -eu

rm -rf .build
mkdir -p .build
javac -d .build src/Calculator.java test/CalculatorTest.java
java -ea -cp .build CalculatorTest
