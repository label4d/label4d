# Potree point selection

The app uses Potree 2 uncompressed files, not the Potree viewer runtime.
Selection follows the upstream viewer's root-first traversal, frustum checks,
projected size priority and point budget:
https://github.com/potree/potree/blob/develop/src/Potree_update_visibility.js

The hierarchy is additive: parents contain samples not repeated in children.
Keep ancestors when refining. Do not globally rank arbitrary nodes by depth.

`PotreeSelection.ts` selects visible branches using actual camera projection
and box-surface distance. Stop refinement at a target projected spacing of
1.5 CSS pixels by default (adjustable with the density slider), with a small hysteresis band. Limit the sum of draw counts to
viewport area / target spacing squared (maximum 480,000); incremental layers also have local caps.
The default budget is four times the initial sparse setting, without enlarging point sprites.
Traversal and draw allocation are separate phases. A dense root must never
consume the budget before the selector discovers zoom-dependent descendants.
After discovering visible detail, distribute the draw budget with capped,
square-root density weights across nodes, keeping additive ancestor samples.
The traversal has a 4096-node safety ceiling independent of source point counts.

These are density heuristics, not a guarantee of one point per screen cell:
overlapping surfaces and uneven source distributions can remain dense.

Stable seeded permutations make geometry prefixes unbiased by source order.
The view uses drawRange for nested sampling, fixed 2.5-CSS-pixel circular point sprites by default,
and gradual increases in displayed counts. The point-size slider adjusts both
single-frame and Potree sprites together from 1 to 6 CSS pixels (step 0.25),
independently of the density slider. Both layers share the same shader and
device-pixel-ratio handling. Reductions immediately respect the
budget. No random resampling occurs between frames. Cached nodes outside the
current selection are hidden, and late obsolete requests cannot add them back.
Ancestor data must arrive before children are requested. At most 12 node loads
are pending; inactive GPU buffers are evicted above 128 MiB / 256 nodes.

Changing point size or color alone cannot cure uneven sample density. Keep
height ranges global. For diagnosis the existing __lfPotreeDebug methods can
isolate the Potree layer, display node bounds/colors and reduce sampleRatio;
getStats distinguishes cached, pending, selected and actually drawn points.
