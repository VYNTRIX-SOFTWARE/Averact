SELECT json_build_object(
  'orderId', po.id::TEXT,
  'supplier', po.supplier,
  'amountMinor', po.amount_minor::TEXT,
  'requestKey', ar.request_key
)::TEXT
FROM averact_demo.action_requests ar
JOIN averact_demo.purchase_orders po ON po.id = ar.order_id
WHERE ar.request_key = :'request_key';
