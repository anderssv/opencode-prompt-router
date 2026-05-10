import { describe, test, expect } from "bun:test";
import { tokenize } from "../core/tokenizer";

describe("tokenize", () => {
  test("empty string returns empty array", () => {
    const result = tokenize("");

    expect(result).toEqual([]);
  });

  test("single word is lowercased", () => {
    const result = tokenize("Refactor");

    expect(result).toEqual(["refactor"]);
  });

  test("multiple words split on whitespace", () => {
    const result = tokenize("review kotlin code");

    expect(result).toEqual(["review", "kotlin", "code"]);
  });

  test("tokens shorter than 3 chars are dropped", () => {
    const result = tokenize("a an the kotlin");

    expect(result).toEqual(["the", "kotlin"]);
  });

  test("punctuation is treated as a separator", () => {
    const result = tokenize("review,kotlin.code!please");

    expect(result).toEqual(["review", "kotlin", "code", "please"]);
  });

  test("trailing 'ing' is stripped", () => {
    const result = tokenize("running");

    expect(result).toEqual(["runn"]);
  });

  test("trailing 'ed' is stripped", () => {
    const result = tokenize("jumped");

    expect(result).toEqual(["jump"]);
  });

  test("trailing 's' is stripped", () => {
    const result = tokenize("cats");

    expect(result).toEqual(["cat"]);
  });

  test("stemming does not shorten below 3 chars", () => {
    const result = tokenize("was");

    expect(result).toEqual(["was"]);
  });

  test("does not strip trailing 's' from words ending in 'ss' or 'xs'", () => {
    // "access" → should stay "access", not become "acces"
    // "process" → should stay "process", not become "proces"
    const result = tokenize("access process");

    expect(result).toEqual(["access", "process"]);
  });
});
