"""Writes test/logic-vectors.json: random sequences of status packets and what the
reference implementation (logic.py of the integration "Ambientika for Home Assistant",
the same rules as the Ambientika MQTT Bridge) shows for them. lib/logic.js must show the same.

    python3 scripts/make_logic_vectors.py <path to custom_components/ambientika/logic.py>
"""
import importlib.util, json, logging, math, random, sys

spec = importlib.util.spec_from_file_location("logic", sys.argv[1])
logic = importlib.util.module_from_spec(spec); spec.loader.exec_module(logic)
log = logging.getLogger("vectors"); log.addHandler(logging.NullHandler()); log.propagate = False

# No NaN: JSON of the cloud cannot carry one, and Python compares NaN by identity.
SPECIAL = ["inf", "-inf", None, True, "text"]

def enc(v):
    if isinstance(v, float) and not math.isfinite(v):
        return "nan" if math.isnan(v) else ("inf" if v > 0 else "-inf")
    return v

def dec(v):
    return float(v) if v in ("nan", "inf", "-inf") else v

def value(rng, kind, last):
    r = rng.random()
    if kind == "humidity":
        if r < 0.50: return round(min(100, max(1, (last if isinstance(last, (int, float)) and not isinstance(last, bool) and math.isfinite(last) else 50) + rng.uniform(-6, 6))), rng.choice([0, 1]))
        if r < 0.62: return rng.choice([0, 0.0, 5, 12, 18, 19.9, 20, 22, 24.9, 25, 26])
        if r < 0.72: return rng.choice([100, 100.5, 101, 130, 255, 1, 0.9])
        if r < 0.80: return dec(rng.choice(SPECIAL))
        return rng.randint(1, 100)
    if r < 0.60: return round((last if isinstance(last, (int, float)) and not isinstance(last, bool) and math.isfinite(last) else 20) + rng.uniform(-3, 3), 1)
    if r < 0.72: return rng.choice([-40, -40.1, 85, 85.1, 999, -273, 0])
    if r < 0.80: return dec(rng.choice(SPECIAL))
    return round(rng.uniform(-10, 40), 1)

cases = []
for seed in range(150):
    rng = random.Random(seed)
    poll = rng.choice([30, 30, 30, 10, 60])
    m = logic.Measurements(log, poll)
    now = 1000.0
    t = h = None
    steps = []
    status = None
    for _ in range(rng.randint(5, 120)):
        r = rng.random()
        now += poll if r < 0.7 else rng.choice([poll * 2, poll * 3, 1, 5, 200, 700, 4000]) if r < 0.9 else rng.uniform(1, 90)
        now = round(now, 3)
        if status is not None and rng.random() < 0.2:
            pass  # the same packet again
        else:
            t = value(rng, "temperature", t); h = value(rng, "humidity", h)
            status = {"operatingMode": rng.choice(["Smart", "Night"]), "temperature": t, "humidity": h}
        fresh = m.is_fresh("X", status, now)
        ts, ta = m.measured("X", "temperature", status["temperature"], fresh, now)
        hs, ha = m.measured("X", "humidity", status["humidity"], fresh, now)
        steps.append({"now": round(now, 3), "status": {k: enc(v) for k, v in status.items()}, "want": [enc(ts), enc(hs), ta, ha]})
    cases.append({"poll": poll, "steps": steps})
json.dump(cases, open("test/logic-vectors.json", "w"), separators=(",", ":"))
print(len(cases), "cases,", sum(len(c["steps"]) for c in cases), "steps")
