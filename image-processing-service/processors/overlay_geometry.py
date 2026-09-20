"""Pure geometry: no image IO, random labels or raster output."""
import math


def valid_bbox(box, width, height):
    return (isinstance(box, list) and len(box) == 4
            and all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in box)
            and box[0] >= 0 and box[1] >= 0 and box[2] > 0 and box[3] > 0
            and box[0] + box[2] <= width + 0.01 and box[1] + box[3] <= height + 0.01)


def compute_overlay(payload):
    width, height = payload.get('width'), payload.get('height')
    if isinstance(width, bool) or isinstance(height, bool) or not isinstance(width, (int, float)) or not isinstance(height, (int, float)) or not math.isfinite(width) or not math.isfinite(height) or width <= 0 or height <= 0:
        raise ValueError('invalid_dimensions')
    teeth, brackets = payload.get('teeth', []), payload.get('brackets', [])
    if not isinstance(teeth, list) or not isinstance(brackets, list) or any(not isinstance(p, dict) for p in teeth + brackets):
        raise ValueError('invalid_annotations')
    ids = [p.get('id') for p in teeth + brackets]
    if any(type(i) is not int or i <= 0 for i in ids) or len(set(ids)) != len(ids):
        raise ValueError('invalid_parent_identity')
    if any(not valid_bbox(p.get('bbox'), width, height) for p in teeth + brackets):
        raise ValueError('invalid_bbox')
    regions, issues = [], []
    for tooth in teeth:
        x, y, w, h = tooth['bbox']
        candidates = []
        for bracket in brackets:
            bx, by, bw, bh = bracket['bbox']
            if x < bx + bw / 2 < x + w and y < by + bh / 2 < y + h:
                candidates.append(bracket)
        if len(candidates) != 1:
            issues.append({'parent_id': tooth['id'], 'reason': 'missing_bracket' if not candidates else 'ambiguous_bracket'})
            continue
        bx, by, bw, bh = candidates[0]['bbox']
        boxes = {'top': [x, y, w, by-y], 'bottom': [x, by+bh, w, y+h-by-bh],
                 'left': [x, by, bx-x, bh], 'right': [bx+bw, by, x+w-bx-bw, bh]}
        if any(not valid_bbox(b, width, height) for b in boxes.values()):
            issues.append({'parent_id': tooth['id'], 'reason': 'invalid_regions'})
            continue
        regions.extend({'parent_id': tooth['id'], 'region': region, 'bbox': box} for region, box in boxes.items())
    return {'schema_version': 1, 'regions': regions, 'issues': issues}
