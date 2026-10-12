# ADR 0008: Require a secondary Eufy account

Status: accepted (2026-10-13)

## Context

Eufy allows one active session per account; a bridge login with the main account logs the
phone app out and vice versa.

## Decision

Documentation and the config flow tell users to create a secondary account (same country as
the main account, otherwise the devices live on other regional servers), share the HomeBase
with it **with admin rights**, and accept the invitation once in the app. The bridge also sets
`acceptInvitations: true`.
