# Excerpt: webhook retry design report

A made-up source, written for this example.

## Summary

**Retries add no quota.** Each endpoint belongs to one event family and has at most one retry schedule, so every delivery to it follows the same delays. Original events stay the only numbers that count toward a customer's quota. A retry count can come later as a figure on the dashboard, never as a charge.

## Decided

| Call | Decision |
|---|---|
| Retries and quota | Quota stays per original event only. Retries never count toward it. |

- **The retry delays and the threshold** of 20 consecutive failures over 6 hours stay starting points, to tune in production.

## Proposed retry schedules

| Family (key) | Retry schedule | Notes |
|---|---|---|
| **Payment** (`payment`) | 1 minute, 10 minutes, and 1 hour | A 10-second retry is too soon to help (4 of 130 failures recovered). It joins the 1-minute retry. |
| **Order** (`order`) | 5 minutes and 1 hour | Timeouts fold into server errors (5 endpoints). |
| **Account** (`account`) | 1 hour | Don't retry a `410 Gone` response: the receiver has removed the endpoint. |

- **An endpoint is disabled only after at least 20 consecutive failures over at least 6 hours.** Below that, its deliveries keep following the schedule.

- **One retry schedule per endpoint, and at most three retries per delivery.** A fourth retry recovered no deliveries in the pilot.
