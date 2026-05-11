---
name: kotlin-context-di
description: Manual dependency injection using SystemContext (production) and TestContext (test doubles) patterns for Kotlin. Use when structuring service dependencies, wiring application components, or creating test contexts without DI frameworks.
tags: [kotlin, dependency-injection, DI, context, wiring, testing, SystemContext, TestContext]
---

# Kotlin Context DI

Manual dependency injection using context objects instead of DI frameworks.

## When To Use

- Structuring service dependencies in Kotlin
- Wiring application components without a DI framework
- Creating test contexts with test doubles

## Pattern

- **SystemContext** — Production wiring of all dependencies
- **TestContext** — Test doubles for isolated testing
- Extension functions for clean access to dependencies
