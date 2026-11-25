# Test pictures

A 320×96 balance screen, rendered by Chromium at device scale 1 and saved as JPEG at quality 80, the way `snap`
writes them.

- `balance.jpg`: the screen, "−1,250.00 DKK".
- `balance-edge-noise.jpg`: the same picture after random jitter of up to ±20 on the pixels along the sidebar's
  edge (x 94–101), re-encoded as JPEG at quality 80. This is the noise that made untouched screens read as changed.
- `balance-no-minus.jpg`: rendered with "1,250.00": the minus sign is gone.
- `balance-comma.jpg`: rendered with "−1,250,00": the decimal point became a comma, five pixels at this size.
