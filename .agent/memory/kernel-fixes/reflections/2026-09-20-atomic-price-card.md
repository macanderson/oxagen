# Atomic price card

A shared effective instant does not make sequential price writes atomic. A run can seal between classes and retain a blended price. Keep the existing single-class capability compatible, add other classes to the same call, and write the card through one tenant transaction.

Lock classes in sorted order before taking the default effective instant. The same order prevents overlapping cards from acquiring class locks in opposite orders. An injected failure after the first SQL insert must leave both old classes intact. A concurrent production rollup must see the whole old card until commit and the whole new card afterward.

A missing response does not prove rollback. Keep the form values and the failure message, but do not label an unavailable response as an unchanged price book.

Independent coverage review requested. CI runs the tests. No local tests ran for this change.
