---
title: Licensing
description: The two licenses anarchon is offered under, where their texts are, and what the commercial license asks for.
---

anarchon is offered under two licenses, and you choose one. This page summarizes them and points to their texts. **The license files are authoritative**, and nothing here is legal advice.

## Which licenses are available?

| | GNU AGPLv3 | Commercial license |
| --- | --- | --- |
| Text | [`LICENSE`](https://github.com/aristoteliss/anarchon/blob/main/LICENSE) | [`COMMERCIAL_LICENSE.txt`](https://github.com/aristoteliss/anarchon/blob/main/COMMERCIAL_LICENSE.txt) |
| What it is | The GNU Affero General Public License, version 3: a copyleft license | The Aristotelis Commercial Software License Agreement, version 1.1, 2026 |
| Fee | None | An annual fee set by revenue tier; $0 in the first tier |

## Where are the authoritative texts?

In the two files linked above, at the root of the repository. Both also ship inside the npm package, next to its `package.json`, so the terms that apply to a version are the ones in that version's files.

## What does the AGPL option ask for?

The AGPLv3 is a copyleft license. Read its terms to see what they require of your application. Its section 13, "Remote Network Interaction", is about modified versions that users interact with remotely over a network.

This page doesn't interpret the AGPL for your case. If you can't tell how it applies to your application, take legal advice or use the commercial license.

## What does the commercial license grant?

Section 1 grants a non-exclusive, worldwide, non-transferable license to use, modify, integrate and distribute anarchon in commercial applications without the copyleft obligations of the AGPLv3. Under it you are not required to open-source your proprietary code that integrates with anarchon.

The grant applies once you accept the agreement and comply with its payment terms.

## What does the free tier say, and how do I register?

Tier 1 covers gross revenue up to $500,000 USD, with a fee of $0.

To register for Tier 1, section 3 says to contact the licensor at `aristotelis@ik.me`. The agreement names no other way to register.

## Which revenue is the fee based on?

Section 2 bases the fee on "Your (or Your organization's) total gross global revenue for the most recently completed fiscal year". It names the whole revenue of you or your organization, and no narrower base.

## What are the tiers, the fees and the contact?

The brackets are marginal: each rate applies only to the portion of gross revenue inside its bracket, and the annual fee is the sum of those amounts.

| Tier | Portion of gross revenue (USD) | Rate on that portion |
| --- | --- | --- |
| 1 | Up to 500,000 | 0% |
| 2 | Above 500,000, up to 10,000,000 | 0.1% |
| 3 | Above 10,000,000, up to 50,000,000 | 0.05% |
| 4 | Above 50,000,000 | 0.01% |

The total annual fee never exceeds $50,000 USD. The agreement gives this example: for gross revenue of $20,000,000, the fee is 0.1% of $9,500,000 ($9,500) plus 0.05% of $10,000,000 ($5,000), a total of $14,500.

Section 3 adds:

- Fees are calculated once a year and are due within 90 days after the close of your fiscal year.
- You keep records adequate to verify your revenue tier.
- To pay, you contact the licensor at `aristotelis@ik.me`.

## Is there a warranty?

No. Both licenses provide the software "as is", without warranty: sections 15 and 16 of the AGPLv3, and section 4 of the commercial license.

## What if my case isn't clearly covered?

Read both texts first. If they don't answer your question, write to `aristotelis@ik.me` before you adopt anarchon, or take legal advice. Don't rely on this page, or on an answer in an issue, in place of the license text.
