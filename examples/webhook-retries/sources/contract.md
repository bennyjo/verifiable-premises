# Excerpt: phase 1 contract (retry rules for webhook deliveries)

A made-up source, written for this example.

## Why

The webhook service sends three event families: Payment, Order, and Account. Customers want failed deliveries to reach them without a manual resend ("we missed a payment event during a deploy"). The first step is a rule: each endpoint may use at most one retry schedule, chosen from its event family and adjustable per endpoint. Retries never count toward a customer's delivery quota; quota stays per original event.

## What to build

1. Add an optional `retryClass` string to `Delivery` (`src/delivery.ts`), and a `SCHEDULES` list per event family, with the delays and the threshold, next to `FAMILIES` in `src/families.ts`. The starting threshold is 20 consecutive failures over 6 hours; it is a tunable starting point.

## The retry rules

- Account: retry every failure after 1 hour, including 410 Gone (`410`).
- Order: retry timeouts as their own class after 1 minute, and server errors after 5 minutes and 1 hour.
- Payment: retry after 10 seconds, then 1 minute, then 10 minutes, then 1 hour.

Each delivery retries on its family's schedule, whose delays and disable threshold are starting points to tune in production.
