#!/usr/bin/env python3
"""The paperwork behind the Meridian Trade Services demo shipments, as PDFs: commercial invoices,
a packing list, a USMCA certification of origin, two customs powers of attorney and the brokerage's
entry SOP. Figures match records.json and what the ACE Entry Workbench computes.

    python3 scripts/demo-meridian/make_docs.py <out-dir>
"""
import json
import os
import sys

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "..", "build", "meridian-docs")
os.makedirs(OUT, exist_ok=True)
RECORDS = {r["id"]: r for r in json.load(open(os.path.join(HERE, "records.json")))["records"]}

styles = getSampleStyleSheet()
H1 = ParagraphStyle("h1", parent=styles["Heading1"], fontSize=17, spaceAfter=4, textColor=colors.HexColor("#0d2240"))
H2 = ParagraphStyle("h2", parent=styles["Heading2"], fontSize=11.5, spaceBefore=10, spaceAfter=4, textColor=colors.HexColor("#0d2240"))
BODY = ParagraphStyle("body", parent=styles["BodyText"], fontSize=9.5, leading=13)
SMALL = ParagraphStyle("small", parent=BODY, fontSize=8.5, leading=11, textColor=colors.HexColor("#475569"))
NAVY = colors.HexColor("#0d2240")
LINE = colors.HexColor("#cbd5e1")


def money(n):
    return "${:,.2f}".format(n)


def grid(rows, widths, header=True):
    table = Table(rows, colWidths=widths)
    style = [
        ("FONT", (0, 0), (-1, -1), "Helvetica", 8.8),
        ("GRID", (0, 0), (-1, -1), 0.5, LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]
    if header:
        style += [("BACKGROUND", (0, 0), (-1, 0), NAVY), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white), ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 8.8)]
    table.setStyle(TableStyle(style))
    return table


def p(text, style=BODY):
    return Paragraph(text, style)


def build(name, story):
    path = os.path.join(OUT, name)
    SimpleDocTemplate(path, pagesize=letter, leftMargin=0.7 * inch, rightMargin=0.7 * inch, topMargin=0.6 * inch, bottomMargin=0.6 * inch,
                      title=name[:-4], author="Meridian Trade Services").build(story)
    return path


SHIPMENTS = {
    "MTS-4471": dict(
        invoice="QCI-26-10-4471", date="October 6, 2026",
        seller=["Quanta Computer Inc.", "211 Wenhua 2nd Rd., Guishan Dist.", "Taoyuan City 33377, Taiwan"],
        buyer=["Lakeshore Electronics Inc.", "2250 Walden Ave", "Cheektowaga, NY 14225, USA"],
        terms="FOB Kaohsiung", vessel="MAERSK KENSINGTON / 642E", loading="Kaohsiung, Taiwan", discharge="Newark, NJ (4601)",
        lines=[("QN-14U7", "14-inch notebook computer, Intel Core Ultra 7, 16 GB RAM, 512 GB SSD, 1.4 kg", "8471.30.0100", 240, "No.", 612.00)],
        packages="20 cartons on 4 pallets", gross="1,180 kg", net="336 kg"),
    "MTS-4472": dict(
        invoice="PEC-INV-88213", date="October 9, 2026",
        seller=["Penang Energy Cells Sdn. Bhd.", "18 Lebuh Bukit Kecil 6, Bayan Lepas", "11900 Penang, Malaysia"],
        buyer=["Lakeshore Electronics Inc.", "2250 Walden Ave", "Cheektowaga, NY 14225, USA"],
        terms="FOB Penang", vessel="ONE HARMONY / 071E", loading="Penang, Malaysia", discharge="Newark, NJ (4601)",
        lines=[("PEC-3S56", "Lithium-ion battery pack, 11.4 V, 56 Wh, for notebook computers (UN3480, Class 9)", "8507.60.0090", 1800, "No.", 38.50)],
        packages="60 cartons on 6 pallets", gross="742 kg", net="468 kg"),
    "MTS-4473": dict(
        invoice="NPH-2026-1187", date="October 21, 2026",
        seller=["Northern Polymer Housewares Ltd.", "450 Kipling Ave", "Toronto, ON M8Z 5E5, Canada"],
        buyer=["Harborview Home Goods LLC", "40 Commerce Dr", "Edison, NJ 08837, USA"],
        terms="FCA Toronto", vessel="Niagara Freight Lines, trailer 5312 (PRO NFLT0098821)", loading="Toronto, ON", discharge="Buffalo-Niagara Falls, NY (0901)",
        lines=[("NPH-FS10", "Polypropylene food storage container set, 10 pieces with lids", "3924.10.4000", 6600, "No.", 6.25)],
        packages="275 cartons on 11 pallets", gross="5,940 kg", net="4,620 kg"),
}


def invoice(ref):
    s, r = SHIPMENTS[ref], RECORDS[ref]["values"]
    total = sum(q * price for _, _, _, q, _, price in s["lines"])
    assert abs(total - float(r["value"])) < 0.01, (ref, total, r["value"])
    story = [
        p("COMMERCIAL INVOICE", H1),
        p(f"Invoice {s['invoice']} · {s['date']} · Broker reference {ref} (Meridian Trade Services, filer MT9)", SMALL),
        Spacer(1, 10),
        grid([["Seller / exporter", "Buyer / consignee / importer of record"],
              [p("<br/>".join(s["seller"])), p("<br/>".join(s["buyer"]) + f"<br/>IRS no. {r['ior_number']}")]], [3.5 * inch, 3.5 * inch]),
        Spacer(1, 8),
        grid([["Terms of sale", "Currency", "Country of origin", "Manufacturer ID"],
              [s["terms"], "USD", r["origin"], r["mid"]]], [1.75 * inch] * 4),
        Spacer(1, 8),
        grid([["Conveyance", "Port of loading", "Port of discharge / entry", "B/L or PRO"],
              [p(s["vessel"]), s["loading"], s["discharge"], r["bill_of_lading"]]], [2.2 * inch, 1.5 * inch, 1.8 * inch, 1.5 * inch]),
        Spacer(1, 10),
        grid([["Part no.", "Description", "HTS (U.S.)", "Qty", "Unit", "Unit price", "Amount"]]
             + [[a, p(b), c, f"{q:,}", u, money(pr), money(q * pr)] for a, b, c, q, u, pr in s["lines"]]
             + [["", p("<b>Total invoice value</b>"), "", "", "", "", money(total)]],
             [0.75 * inch, 2.6 * inch, 0.95 * inch, 0.55 * inch, 0.45 * inch, 0.8 * inch, 0.9 * inch]),
        Spacer(1, 8),
        p(f"Packages: {s['packages']} · Gross weight {s['gross']} · Net weight {s['net']}"),
        p("Price includes all assists and packing; no royalties or proceeds of subsequent resale accrue to the seller. Buyer and seller are not related (19 U.S.C. 1401a(g)).", SMALL),
        Spacer(1, 14),
        p("I declare that this invoice shows the actual price of the goods described, that all other particulars are true and correct.", SMALL),
        p(f"Signed for the seller · {s['seller'][0]}", SMALL),
    ]
    return build(f"Commercial Invoice {s['invoice']} ({ref}).pdf", story)


def packing_list(ref):
    s = SHIPMENTS[ref]
    story = [
        p("PACKING LIST", H1), p(f"Against invoice {s['invoice']} · Broker reference {ref}", SMALL), Spacer(1, 10),
        grid([["Cartons", "Contents", "Units / carton", "Net kg / carton", "Gross kg / carton"],
              ["1–20", "QN-14U7 notebook computer, retail-boxed", "12", "16.8", "59.0"]], [0.8 * inch, 2.8 * inch, 1.1 * inch, 1.1 * inch, 1.2 * inch]),
        Spacer(1, 8),
        p(f"Total: {s['packages']} · Gross {s['gross']} · Net {s['net']} · Container MRKU 482 917 3 (40' HC), seal ML-TW 7718204"),
        p("Marks: LAKESHORE / CHEEKTOWAGA NY / PO 55-20817 / C/NO. 1-20 / MADE IN TAIWAN", SMALL),
    ]
    return build(f"Packing List {s['invoice']} ({ref}).pdf", story)


def usmca():
    r = RECORDS["MTS-4473"]["values"]
    story = [
        p("USMCA CERTIFICATION OF ORIGIN", H1),
        p("Minimum data elements per USMCA Article 5.2 and Annex 5-A; 19 CFR 182.12. Covers broker reference MTS-4473.", SMALL),
        Spacer(1, 10),
        grid([
            ["1. Certifier", "Producer"],
            ["2. Certifier", p("Daniel Okafor, Trade Compliance Manager, Northern Polymer Housewares Ltd., 450 Kipling Ave, Toronto, ON M8Z 5E5 · +1 416 555 0148 · trade@northernpolymer.test")],
            ["3. Exporter", p("Northern Polymer Housewares Ltd., 450 Kipling Ave, Toronto, ON M8Z 5E5, Canada")],
            ["4. Producer", p("Same as exporter")],
            ["5. Importer", p(f"Harborview Home Goods LLC, 40 Commerce Dr, Edison, NJ 08837, USA · IRS no. {r['ior_number']}")],
            ["6. Description and HS", p("Polypropylene food storage container sets, 10 pieces with lids (part NPH-FS10) · HS 3924.10")],
            ["7. Origin criterion", "B — produced entirely in Canada from non-originating resin meeting the product-specific rule"],
            ["8. Blanket period", "January 1, 2026 to December 31, 2026"],
        ], [1.6 * inch, 5.4 * inch], header=False),
        Spacer(1, 10),
        p("9. I certify that the goods described in this document qualify as originating and the information contained in this document is true and accurate. "
          "I assume responsibility for proving such representations and agree to maintain and present upon request or to make available during a verification visit, "
          "documentation necessary to support this certification."),
        Spacer(1, 10),
        p("Daniel Okafor · Trade Compliance Manager · October 21, 2026", SMALL),
    ]
    return build("USMCA Certification of Origin - Northern Polymer (MTS-4473).pdf", story)


def poa(client, address, irs, signer):
    story = [
        p("CUSTOMS POWER OF ATTORNEY", H1),
        p("Grant of authority to a licensed customs broker under 19 CFR 141.46", SMALL), Spacer(1, 10),
        p(f"KNOW ALL PERSONS BY THESE PRESENTS: That <b>{client}</b>, {address}, IRS no. {irs}, a corporation organized under the laws of the State of "
          f"{'New York' if 'NY' in address else 'New Jersey'}, hereby constitutes and appoints <b>Meridian Trade Services</b>, a licensed customs broker "
          "(national permit, filer code MT9), as a true and lawful agent and attorney of the grantor, for and in the name, place, and stead of said grantor:"),
        Spacer(1, 6),
        p("To make, endorse, sign, declare, or swear to any customs entry, withdrawal, declaration, certificate, bill of lading, or other document required by law "
          "or regulation in connection with the importation, transportation, or exportation of any merchandise shipped or consigned by or to said grantor; "
          "to sign, seal, and deliver for and as the act of said grantor any bond required by law or regulation in connection with the entry or withdrawal of "
          "imported merchandise; to authorize other customs brokers duly licensed within the territory to act as grantor's agent; to receive, endorse and collect "
          "checks issued for customs duty refunds in grantor's name; and generally to transact at the customhouses in any district any and all customs business, "
          "including making, signing, and filing of protests under section 514 of the Tariff Act of 1930."),
        Spacer(1, 6),
        p("This power of attorney remains in full force and effect until revocation in writing is duly given to and received by the grantee."),
        Spacer(1, 16),
        grid([["Signed for the grantor", "Title", "Date"], [signer, "Chief Financial Officer", "March 3, 2026"]], [2.8 * inch, 2.2 * inch, 2.0 * inch]),
        Spacer(1, 8),
        p("Broker's file: Meridian keeps this power of attorney and the client's CBP Form 5106 importer identity record with the client file (19 CFR 141.46; 19 CFR 111.23).", SMALL),
    ]
    return build(f"Customs Power of Attorney - {client.replace(' Inc.', '').replace(' LLC', '')}.pdf", story)


def sop():
    rows = [
        ["Step", "What", "Rule / deadline"],
        ["1", p("Ocean shipments: confirm the importer's ISF (10+2) was filed"), p("24 hours before lading at the foreign port (19 CFR 149.2)")],
        ["2", p("Collect commercial invoice, packing list, B/L, and any origin certification; save them to the vault under the client"), p("Invoice requirements: 19 CFR 141.86")],
        ["3", p("Classify each line to the 10-digit HTSUS number; check Chapter 99 and AD/CVD"), p("Reasonable care (19 U.S.C. 1484)")],
        ["4", p("File entry / release (CBP 3461 data via ACE) for cargo release"), p("Within 15 calendar days of arrival (19 CFR 142.2)")],
        ["5", p("File the entry summary (CBP 7501) in the ACE Entry Workbench: <i>replay “file ACE entry” for the shipment</i>"), p("Within 10 working days of release (19 CFR 142.12)")],
        ["6", p("Duty, MPF and HMF go on the daily statement; MPF 0.3464% (min $34.58, max $670.86, FY2027), HMF 0.125% ocean only"), p("CBP Dec. 26-14; 19 CFR 24.23 / 24.24")],
        ["7", p("Send the client the entry number and the totals; post it in the client's space"), p("Same day")],
        ["8", p("Keep the entry records"), p("5 years from date of entry (19 CFR 163.4)")],
    ]
    story = [
        p("SOP — Consumption Entries (Type 01)", H1),
        p("Meridian Trade Services · Entry Operations · revision 7, October 2026", SMALL), Spacer(1, 10),
        grid(rows, [0.45 * inch, 3.9 * inch, 2.65 * inch]),
        Spacer(1, 10),
        p("USMCA goods: claim SPI “S” on the line only with a valid certification of origin on file (19 CFR 182.12). Continuous bond (type 8, surety 457) covers all clients; "
          "the amount is reviewed yearly at the greater of $50,000 or 10% of duties, taxes and fees paid in the prior 12 months.", BODY),
    ]
    return build("Meridian SOP - Consumption Entries (Type 01).pdf", story)


if __name__ == "__main__":
    made = [
        ("Entries", invoice("MTS-4471")), ("Entries", packing_list("MTS-4471")),
        ("Entries", invoice("MTS-4472")), ("Entries", invoice("MTS-4473")), ("Entries", usmca()),
        ("Lakeshore Electronics", poa("Lakeshore Electronics Inc.", "2250 Walden Ave, Cheektowaga, NY 14225", "16-4827193-00", "Karen Whitfield")),
        ("Compliance", poa("Harborview Home Goods LLC", "40 Commerce Dr, Edison, NJ 08837", "22-3190457-00", "Raymond Osei")),
        ("", sop()),
    ]
    print(json.dumps([{"space": space, "path": path} for space, path in made]))
