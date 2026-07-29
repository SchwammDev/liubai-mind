import { test } from "node:test";
import assert from "node:assert/strict";

import { detectLang } from "./lang.ts";

test("a python file maps to python", () => {
  assert.equal(detectLang("app/foo.py"), "python");
});

test("a python stub file maps to python", () => {
  assert.equal(detectLang("app/foo.pyi"), "python");
});

test("a typescript file maps to typescript", () => {
  assert.equal(detectLang("app/foo.ts"), "typescript");
});

test("a mts file maps to typescript", () => {
  assert.equal(detectLang("app/foo.mts"), "typescript");
});

test("a cts file maps to typescript", () => {
  assert.equal(detectLang("app/foo.cts"), "typescript");
});

test("a tsx file maps to typescript", () => {
  assert.equal(detectLang("app/foo.tsx"), "typescript");
});

test("a cpp file maps to cpp", () => {
  assert.equal(detectLang("app/foo.cpp"), "cpp");
});

test("a cc file maps to cpp", () => {
  assert.equal(detectLang("app/foo.cc"), "cpp");
});

test("a cxx file maps to cpp", () => {
  assert.equal(detectLang("app/foo.cxx"), "cpp");
});

test("an hpp header maps to cpp", () => {
  assert.equal(detectLang("app/foo.hpp"), "cpp");
});

test("an hh header maps to cpp", () => {
  assert.equal(detectLang("app/foo.hh"), "cpp");
});

test("an hxx header maps to cpp", () => {
  assert.equal(detectLang("app/foo.hxx"), "cpp");
});

test("a plain c header maps to cpp", () => {
  assert.equal(detectLang("app/foo.h"), "cpp");
});

test("an uppercased extension still matches its lowercase language", () => {
  assert.equal(detectLang("APP/FOO.PY"), "python");
  assert.equal(detectLang("APP/FOO.TS"), "typescript");
  assert.equal(detectLang("APP/FOO.H"), "cpp");
});

test("an unknown extension yields no language", () => {
  assert.equal(detectLang("README.md"), undefined);
});

test("a path with no extension yields no language", () => {
  assert.equal(detectLang("app/Makefile"), undefined);
});

test("a bare filename with no extension yields no language", () => {
  assert.equal(detectLang("Makefile"), undefined);
});
