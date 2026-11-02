SELECT json_build_object(
  'requestCount', (SELECT COUNT(*)::INT FROM averact_demo.action_requests WHERE request_key = :'request_key'),
  'linkedOrderCount', (SELECT COUNT(*)::INT FROM averact_demo.purchase_orders po
                        JOIN averact_demo.action_requests ar ON po.id = ar.order_id
                        WHERE ar.request_key = :'request_key'),
  'allOrderCount', (SELECT COUNT(*)::INT FROM averact_demo.purchase_orders)
)::TEXT;
