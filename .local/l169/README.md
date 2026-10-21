# Chat warm reload regression experiment

Compare r173 (e1271983), r176 (fbc99b8c), and the lane candidate using the Team-scale fixture with 820 synthetic transcript messages, a 350 ms connect-send floor and 230 ms connect reply latency. Use one quiet AWS c7a.4xlarge lease, eleven interleaved pairs, and separate source-mapped CPU profiles. No private captures or live state.

Primary gates: warm chat reload blocking and final rows improve in at least 9/11 pairs with negative median paired deltas, and return to r173 levels. Report median and IQR plus every paired delta. Secondary gates: hello handled, FCP, first rows, dashboard and board routes; a regression needs non-overlapping IQRs or at least 9/11 worse pairs with a median increase exceeding max(10 ms, 3%).

This is an experiment scaffold, not a product change. Do not merge.
