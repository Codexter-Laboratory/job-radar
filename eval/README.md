# Golden set

`golden.jsonl` holds hand-labelled postings, one JSON object per line.

It is append-only. Relabelling a posting appends a new line with the same `id`
and the loader keeps the last one, so a correction is a plain append and the
history of a changed judgement stays in git.

Labels answer one question: **could this candidate actually take this role,
given where they live and how they invoice?** Not whether the role is
appealing, and not whether the stack matches.

Rules of thumb used while labelling:

- A posting that names no restriction at all is eligible, with `employmentType`
  `unknown`. Silence is not permission, but it is not refusal either.
- A timezone requirement is not a location requirement.
- A requirement to hold work authorisation in a named country is a hard no.
- Hiring through an employer of record is eligible unless the posting limits
  which countries the EOR covers.
- A local tax entity, a local bank account, or on-site days is a hard no.

These are the same rules given to the model in prompt v3. That is deliberate:
the eval measures whether the model applies a stated policy consistently, not
whether it guesses an unstated one.
