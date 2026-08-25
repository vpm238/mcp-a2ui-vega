# The dataset

`ticket_sales.csv` is the demo dataset: one row per ticket **order** for twelve
Broadway shows, ~90 days deep, in `America/New_York` time throughout.

```
order_id,ordered_at,event_date,event_time,show,theatre,section,channel,promo_code,quantity,unit_price,gross,customer_segment,status
ORD-0000001,2026-05-28T06:05:41,2026-05-28,19:00,Moulin Rouge! The Musical!,Al Hirschfeld Theatre,Orchestra,Web,,5,292.00,1460.00,Tourist,paid
```

| column | meaning |
|---|---|
| `ordered_at` | when the order was placed — the sales timeline |
| `event_date` / `event_time` | which performance the seats are for |
| `show` / `theatre` | real Broadway show and the house it played |
| `section` | Orchestra, Front/Rear Mezzanine, Balcony, Box |
| `channel` | Web, Mobile App, Box Office, TodayTix, TKTS Booth, Group Sales, Telecharge |
| `promo_code` | blank, `RUSH25`, `STUDENT`, `TKTS50`, `GROUP20`, `MEMBER10` |
| `quantity` / `unit_price` / `gross` | seats in the order, price per seat, order total |
| `customer_segment` | Tourist, Local, Member, Group, Student |
| `status` | `paid` or `refunded` (~1.5%) |

## Where the numbers come from

**Real:** the shows, their theatres, house sizes, week-by-week capacity, and
average and top ticket prices all come from the [Broadway weekly grosses
dataset](https://github.com/rfordatascience/tidytuesday/tree/master/data/2020/2020-04-28)
(Playbill, published via TidyTuesday) — the 2019–20 season, the last complete
pre-pandemic one in that data.

**Modelled:** individual orders. The source is weekly and aggregate, so there
are no real orders to ship. `tools/build-dataset.mjs` walks each show's real
eight-performance week (dark Monday, matinees Wednesday/Saturday/Sunday), fills
the house to its real capacity for that week, sells this platform's `--share` of
those seats, and splits them into orders across sections, channels, promos and
party sizes. Prices are anchored to each show's real average ticket price, with
the discount stack normalized so the generated average lands within a few
percent of the real one (currently ~$133 against a real ~$132).

Segments behave: a group sale comes through Group Sales in a block of six or
more, students buy singles and pairs on mobile, the TKTS booth only ever sells
its half-price code. `tools/csv.test.mjs` asserts these invariants.

## Regenerating and appending

```bash
npm run data:build                       # rebuild, 90 days ending right now
npm run data:build -- --days 180 --shows 16 --share 0.05
npm run data:append                      # 6 new orders, timestamped now
npm run data:append -- --watch 10        # a live feed: 6 more every 10s
npm run data:append -- --url https://your-worker.workers.dev   # push to the server
```

The build is deterministic: the same `--seed` and flags reproduce the same file
byte for byte. `shows.json` is the extracted per-show profile the append tool
uses, so appending never needs the 5 MB source file.

Rebuild before a demo if the file has gone stale — the dashboard's "today" panel
is only interesting when the newest rows are actually from today.
