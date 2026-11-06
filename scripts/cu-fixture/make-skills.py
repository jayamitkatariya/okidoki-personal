#!/usr/bin/env python3
"""Writes the two AcmeDesk skills scripts/cu-replay-eval.py replays:

  acmedesk.okiskill        — "acmedesk filing": Asha's return as watch-me records it (clicks and typing,
                             each with its label, role, window and an accessibility locator). Classic replay.
  acmedesk-smart.okiskill  — "acmedesk filing smart": the same run as the compiler makes it: inputs,
                             a condition for capital gains, a loop over deductions, anchors and checks,
                             the irreversible Submit and a read step for the reference number.

The smart file is what `skill/compile` produces for this recording (kept as a file so the eval doesn't
depend on a model call to start); `cu-replay-eval.py --compile` compiles the recording instead.

  scripts/cu-fixture/make-skills.py
"""
import json
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP = "AcmeDesk"
BUNDLE = "dev.okidoki.acmedesk"
# Where the window was when it was recorded (Quartz points), for the window-relative carry.
WIN = {"winX": 200.0, "winY": 180.0, "winW": 560.0, "winH": 520.0}


def window(screen):
    return f"AcmeDesk — {screen}"


def locator(screen, role, label=None, identifier=None, path=None, sheet=False, subrole=None):
    loc = {"bundleID": BUNDLE, "app": APP, "window": window(screen), "role": role}
    if label:
        loc["label"] = label
    if identifier:
        loc["identifier"] = identifier
    if subrole:
        loc["subrole"] = subrole
    if sheet:
        loc["inSheet"] = True
    loc["path"] = path or (["AXWindow", "AXSheet[1]"] if sheet else ["AXWindow"])
    return loc


def step(text, action, screen, *, label=None, role=None, input=None, x=None, y=None, ident=None, path=None,
         sheet=False, subrole=None, **extra):
    s = {"id": str(uuid.uuid5(uuid.NAMESPACE_URL, "acmedesk/" + text + str(extra.get("repeatOver", "")))),
         "text": text, "app": APP, "action": action, "delay": 0.4}
    if label:
        s["label"] = label
    if role:
        s["role"] = role
    if input is not None:
        s["input"] = input
    if x is not None:
        s["x"], s["y"] = x, y
        s.update(WIN)
        s["winTitle"] = window(screen)
    if role and action in ("click", "select"):
        s["axLocator"] = locator(screen, role, label, ident, path, sheet, subrole)
    s.update(extra)
    return s


def recorded():
    """Asha Rao: no capital gains, no deductions, new regime — exactly what was done."""
    return [
        step("open AcmeDesk", "switch", "Sign in"),
        step("in AcmeDesk, click “Username”", "click", "Sign in", label="Username", role="AXTextField", x=420, y=262, ident="username"),
        step("type “eval”", "type", "Sign in", input="eval"),
        step("in AcmeDesk, click “Password”", "click", "Sign in", label="Password", role="AXTextField", subrole="AXSecureTextField", x=420, y=292, ident="password"),
        step("type “eval”", "type", "Sign in", input="eval"),
        step("in AcmeDesk, click “Sign in”", "click", "Sign in", label="Sign in", role="AXButton", x=262, y=326, ident="sign-in"),
        step("in AcmeDesk, click “Full name”", "click", "Return details", label="Full name", role="AXTextField", x=430, y=262, ident="name"),
        step("type “Asha Rao”", "type", "Return details", input="Asha Rao"),
        step("in AcmeDesk, click “PAN”", "click", "Return details", label="PAN", role="AXTextField", x=430, y=292, ident="pan"),
        step("type “ABCPR1234K”", "type", "Return details", input="ABCPR1234K"),
        step("in AcmeDesk, click “Income”", "click", "Return details", label="Income", role="AXTextField", x=430, y=322, ident="income"),
        step("type “1250000”", "type", "Return details", input="1250000"),
        step("in AcmeDesk, click “Regime”", "click", "Return details", label="Regime", role="AXPopUpButton", x=300, y=352, ident="regime"),
        step("in AcmeDesk, click “New”", "click", "Return details", label="New", role="AXMenuItem", x=300, y=352),
        step("in AcmeDesk, click “Next”", "click", "Return details", label="Next", role="AXButton", x=262, y=440, ident="details-next"),
        step("in AcmeDesk, click “Next”", "click", "Deductions", label="Next", role="AXButton", x=262, y=330, ident="deductions-next"),
        step("in AcmeDesk, click “Submit”", "click", "Deductions", label="Submit", role="AXButton", x=520, y=470, ident="submit", sheet=True),
        step("in AcmeDesk, click “Done”", "click", "Filed", label="Done", role="AXButton", x=262, y=330, ident="done"),
    ]


def anchor(screen, landmark=None):
    a = {"app": APP, "window": screen}
    if landmark:
        a["landmark"] = landmark
    return a


def smart():
    on = lambda screen: {"anchor": anchor(screen)}
    rows = ["AXWindow", "AXGroup[1]", "AXGroup[{{item.index}}]"]
    return [
        step("open AcmeDesk", "switch", "Sign in"),
        step("in AcmeDesk, click “Username”", "click", "Sign in", label="Username", role="AXTextField", ident="username", **on("Sign in")),
        step("type “eval”", "type", "Sign in", input="eval", **on("Sign in")),
        step("in AcmeDesk, click “Password”", "click", "Sign in", label="Password", role="AXTextField", subrole="AXSecureTextField", ident="password", **on("Sign in")),
        step("type the password", "type", "Sign in", input="eval", **on("Sign in")),
        step("in AcmeDesk, click “Sign in”", "click", "Sign in", label="Sign in", role="AXButton", ident="sign-in",
             expect={"windowTitleContains": "Return details"}, **on("Sign in")),
        step("in AcmeDesk, click “Full name”", "click", "Return details", label="Full name", role="AXTextField", ident="name", **on("Return details")),
        step("type {{name}}", "type", "Return details", input="{{name}}", **on("Return details")),
        step("in AcmeDesk, click “PAN”", "click", "Return details", label="PAN", role="AXTextField", ident="pan", **on("Return details")),
        step("type {{pan}}", "type", "Return details", input="{{pan}}", **on("Return details")),
        step("in AcmeDesk, click “Income”", "click", "Return details", label="Income", role="AXTextField", ident="income", **on("Return details")),
        step("type {{income}}", "type", "Return details", input="{{income}}", **on("Return details")),
        step("choose {{regime}} for “Regime”", "select", "Return details", label="Regime", role="AXPopUpButton", ident="regime",
             input="{{regime}}", **on("Return details")),
        step("in AcmeDesk, tick “I have capital gains”", "click", "Return details", label="I have capital gains", role="AXCheckBox",
             ident="has-gains", when="{{gains}}", **on("Return details")),
        step("in AcmeDesk, click “Capital gains”", "click", "Return details", label="Capital gains", role="AXTextField", ident="gains",
             when="{{gains}}", **on("Return details")),
        step("type {{gains}}", "type", "Return details", input="{{gains}}", when="{{gains}}", **on("Return details")),
        step("in AcmeDesk, click “Next”", "click", "Return details", label="Next", role="AXButton", ident="details-next",
             expect={"windowTitleContains": "Deductions"}, **on("Return details")),
        step("in AcmeDesk, click “Add row”", "click", "Deductions", label="Add row", role="AXButton", ident="add-row",
             repeatOver="deductions", repeatLength=4, **on("Deductions")),
        step("choose {{item.section}} for “Section {{item.index}}”", "select", "Deductions", label="Section {{item.index}}", role="AXPopUpButton",
             ident="section-{{item.index}}", path=rows, input="{{item.section}}", **on("Deductions")),
        step("in AcmeDesk, click “Amount {{item.index}}”", "click", "Deductions", label="Amount {{item.index}}", role="AXTextField",
             ident="amount-{{item.index}}", path=rows, **on("Deductions")),
        step("type {{item.amount}}", "type", "Deductions", input="{{item.amount}}", **on("Deductions")),
        step("in AcmeDesk, click “Next”", "click", "Deductions", label="Next", role="AXButton", ident="deductions-next",
             expect={"labelPresent": "Review your return"}, **on("Deductions")),
        step("in AcmeDesk, click “Submit”", "click", "Deductions", label="Submit", role="AXButton", ident="submit", sheet=True,
             irreversible=True, expect={"textContains": "Your return has been filed"},
             anchor=anchor("Deductions", "Review your return")),
        step("read the reference number", "read", "Filed", capture="reference", **on("Filed")),
        step("in AcmeDesk, click “Done”", "click", "Filed", label="Done", role="AXButton", ident="done",
             expect={"windowTitleContains": "Sign in"}, **on("Filed")),
    ]


INPUTS = [
    {"name": "name", "description": "the person's full name", "kind": "text", "source": "request", "example": "Asha Rao"},
    {"name": "pan", "description": "the person's PAN (Indian tax id)", "kind": "text", "pattern": "[A-Z]{5}[0-9]{4}[A-Z]",
     "format": "upper", "source": "document", "example": "ABCPR1234K"},
    {"name": "income", "description": "annual income in rupees", "kind": "money", "format": "plain", "source": "document", "example": "1250000"},
    {"name": "regime", "description": "the tax regime", "kind": "choice", "choices": ["New", "Old"], "source": "document", "example": "New"},
    {"name": "gains", "description": "capital gains in rupees, if any", "kind": "money", "format": "plain", "source": "document",
     "required": False},
    {"name": "deductions", "description": "deductions claimed: section and amount", "kind": "list", "fields": ["section", "amount"],
     "source": "document", "required": False},
    {"name": "reference", "description": "the reference number shown after filing", "kind": "text", "source": "page",
     "required": False, "example": "REF-448990"},
]


def bundle(name, summary, steps, extras=None):
    out = {"format": "okidoki-skill", "version": 2 if extras else 1, "name": name, "summary": summary, "steps": steps,
           "frames": {}, "exportedAt": "2026-11-05T00:00:00Z"}
    if extras:
        out["skill"] = extras
    return out


def main():
    (HERE / "acmedesk.okiskill").write_text(json.dumps(
        bundle("acmedesk filing", "18 steps in AcmeDesk", recorded()), indent=2, ensure_ascii=False) + "\n")
    (HERE / "acmedesk-smart.okiskill").write_text(json.dumps(bundle(
        "acmedesk filing smart", "file an income tax return in AcmeDesk", smart(),
        {"inputs": INPUTS, "intent": "file a person's income tax return in the AcmeDesk app", "itemNoun": "person", "startApp": APP}),
        indent=2, ensure_ascii=False) + "\n")
    print("wrote", HERE / "acmedesk.okiskill", "and", HERE / "acmedesk-smart.okiskill")


if __name__ == "__main__":
    main()
