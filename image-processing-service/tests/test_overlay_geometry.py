import unittest
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location('overlay_geometry', Path(__file__).parents[1] / 'processors' / 'overlay_geometry.py')
geometry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(geometry)
compute_overlay = geometry.compute_overlay


class OverlayGeometryTest(unittest.TestCase):
    def payload(self):
        return dict(width=2400, height=1600, teeth=[dict(id=11, bbox=[100, 100, 400, 600])],
                    brackets=[dict(id=21, bbox=[200, 300, 100, 100])])

    def test_exact_pixels_and_stable_parent(self):
        result = compute_overlay(self.payload())
        self.assertEqual(result['issues'], [])
        self.assertEqual(len(result['regions']), 4)
        self.assertEqual(result['regions'][0], dict(parent_id=11, region='top', bbox=[100, 100, 400, 200]))
        self.assertEqual(result, compute_overlay(self.payload()))

    def test_portrait_and_same_class_multiple_parents(self):
        p = self.payload()
        p.update(width=1600, height=2400)
        p['teeth'].append(dict(id=12, bbox=[600, 100, 400, 600]))
        p['brackets'].append(dict(id=22, bbox=[700, 300, 100, 100]))
        self.assertEqual({r['parent_id'] for r in compute_overlay(p)['regions']}, {11, 12})

    def test_missing_ambiguous_and_zero_area_are_review(self):
        for brackets, reason in [([], 'missing_bracket'),
                                ([dict(id=21, bbox=[200,300,100,100]), dict(id=22, bbox=[210,310,80,80])], 'ambiguous_bracket'),
                                ([dict(id=21, bbox=[100,100,400,600])], 'invalid_regions')]:
            p = self.payload()
            p['brackets'] = brackets
            r = compute_overlay(p)
            self.assertEqual(r['regions'], [])
            self.assertEqual(r['issues'][0]['reason'], reason)

    def test_rejects_invalid_shapes_ids_and_bounds(self):
        for change in [dict(teeth=None), dict(teeth=[None]), dict(width=True), dict(height=float('nan')),
                       dict(teeth=[dict(id=True, bbox=[0,0,1,1])]),
                       dict(teeth=[dict(id=21, bbox=[0,0,1,1])]),
                       dict(teeth=[dict(id=11, bbox=[2300,0,200,100])])]:
            with self.assertRaises(ValueError):
                compute_overlay({**self.payload(), **change})


if __name__ == '__main__':
    unittest.main()
