// SYNTHETIC supplier-delivery demo rows, shared by the Zetaris loader and tests.
const HOUR = 3600000;
const label = "SYNTHETIC DATA";

/** day1: 85 of 100 received, 15 still in transit. day2: the 15 arrived but were never received. */
export function supplierRows(state, now = Date.now()) {
  if (!["day1", "day2"].includes(state)) throw new Error("State must be day1 or day2.");
  const at = (hours) => new Date(now + hours * HOUR).toISOString();
  const observed_at = at(0);
  const row = (fields) => ({ ...fields, synthetic_label: label, observed_at });
  return {
    PURCHASE_ORDERS: [
      row({
        po_id: "PO-1042",
        supplier_id: "SUP-ACME",
        sku: "WIDGET-7",
        ordered_quantity: 100,
        ordered_at: at(-120),
      }),
      row({
        po_id: "PO-1043",
        supplier_id: "SUP-ACME",
        sku: "BOLT-3",
        ordered_quantity: 50,
        ordered_at: at(-96),
      }),
      row({
        po_id: "PO-1044",
        supplier_id: "SUP-NORTH",
        sku: "VALVE-2",
        ordered_quantity: 40,
        ordered_at: at(-100),
      }),
    ],
    GOODS_RECEIPTS: [
      row({
        receipt_id: "GR-1042-1",
        po_id: "PO-1042",
        received_quantity: 85,
        received_at: at(-30),
        recorded_by: "receiving-dock-2",
      }),
      row({
        receipt_id: "GR-1043-1",
        po_id: "PO-1043",
        received_quantity: 50,
        received_at: at(-40),
        recorded_by: "receiving-dock-1",
      }),
      row({
        receipt_id: "GR-1044-1",
        po_id: "PO-1044",
        received_quantity: 30,
        received_at: at(-50),
        recorded_by: "receiving-dock-1",
      }),
    ],
    SHIPMENTS: [
      row({
        shipment_id: "SHP-1042-A",
        po_id: "PO-1042",
        shipped_quantity: 85,
        status: "delivered",
        shipped_at: at(-48),
        eta: at(-30),
      }),
      state === "day1"
        ? row({
            shipment_id: "SHP-1042-B",
            po_id: "PO-1042",
            shipped_quantity: 15,
            status: "in_transit",
            shipped_at: at(-20),
            eta: at(24),
          })
        : row({
            shipment_id: "SHP-1042-B",
            po_id: "PO-1042",
            shipped_quantity: 15,
            status: "delivered",
            shipped_at: at(-20),
            eta: at(-3),
          }),
      row({
        shipment_id: "SHP-1043-A",
        po_id: "PO-1043",
        shipped_quantity: 50,
        status: "delivered",
        shipped_at: at(-60),
        eta: at(-40),
      }),
      row({
        shipment_id: "SHP-1044-A",
        po_id: "PO-1044",
        shipped_quantity: 30,
        status: "delivered",
        shipped_at: at(-70),
        eta: at(-50),
      }),
    ],
    SUPPLIER_CONFIRMATIONS: [
      row({
        confirmation_id: "CONF-1042",
        po_id: "PO-1042",
        confirmed_quantity: 100,
        note: "Shipped in two lots: 85 and 15.",
        confirmed_at: at(-24),
      }),
      row({
        confirmation_id: "CONF-1043",
        po_id: "PO-1043",
        confirmed_quantity: 50,
        note: "Shipped complete.",
        confirmed_at: at(-60),
      }),
      row({
        confirmation_id: "CONF-1044",
        po_id: "PO-1044",
        confirmed_quantity: 30,
        note: "Short shipped 10 units; backordered.",
        confirmed_at: at(-70),
      }),
    ],
  };
}
