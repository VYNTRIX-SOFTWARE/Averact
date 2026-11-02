-- Values are passed as psql variables and quoted as SQL literals (:'var').
-- Never interpolate an untrusted value into the SQL source.
SELECT json_build_object('orderId', x.order_id::TEXT, 'replayed', x.replayed)::TEXT
  FROM averact_demo.create_purchase_order(
    :'request_key', :'supplier', (:'amount_minor')::BIGINT
  ) AS x;
