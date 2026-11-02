-- Synthetic single-tenant transaction safety demonstration (not production schema).
-- PostgreSQL READ COMMITTED, primary-key conflict arbitration, one DB transaction.
CREATE SCHEMA IF NOT EXISTS averact_demo;

CREATE TABLE IF NOT EXISTS averact_demo.purchase_orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  supplier TEXT NOT NULL CHECK (length(btrim(supplier)) > 0),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS averact_demo.action_requests (
  request_key TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  order_id BIGINT UNIQUE REFERENCES averact_demo.purchase_orders(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION averact_demo.create_purchase_order(
  p_key TEXT, p_supplier TEXT, p_amount_minor BIGINT
) RETURNS TABLE(order_id BIGINT, replayed BOOLEAN)
LANGUAGE plpgsql AS $fn$
DECLARE
  v_key TEXT;
  v_order BIGINT;
  v_saved_payload JSONB;
  v_payload JSONB;
BEGIN
  IF p_key IS NULL OR length(p_key) < 1 OR length(p_key) > 200 THEN
    RAISE EXCEPTION 'Invalid idempotency key';
  END IF;
  IF p_supplier IS NULL OR length(btrim(p_supplier)) < 1 OR length(p_supplier) > 200 THEN
    RAISE EXCEPTION 'Invalid supplier';
  END IF;
  IF p_amount_minor IS NULL OR p_amount_minor <= 0 THEN
    RAISE EXCEPTION 'Invalid amount';
  END IF;

  v_payload := jsonb_build_object('supplier', p_supplier, 'amount_minor', p_amount_minor);

  -- The UNIQUE constraint is the concurrency arbiter: a contender waits for
  -- the winner to commit or roll back. It cannot create a second order.
  INSERT INTO averact_demo.action_requests(request_key, payload)
  VALUES (p_key, v_payload)
  ON CONFLICT (request_key) DO NOTHING
  RETURNING request_key INTO v_key;

  IF v_key IS NOT NULL THEN
    INSERT INTO averact_demo.purchase_orders(supplier, amount_minor)
    VALUES (p_supplier, p_amount_minor)
    RETURNING id INTO v_order;

    UPDATE averact_demo.action_requests
       SET order_id = v_order
     WHERE request_key = p_key;

    RETURN QUERY SELECT v_order, FALSE;
    RETURN;
  END IF;

  -- This is a *new statement*, not a query in the INSERT statement's snapshot.
  -- Under READ COMMITTED it can see the committed conflicting request.
  SELECT ar.payload, ar.order_id
    INTO v_saved_payload, v_order
    FROM averact_demo.action_requests ar
   WHERE ar.request_key = p_key;

  IF NOT FOUND OR v_order IS NULL THEN
    RAISE EXCEPTION 'Retryable conflict visibility error';
  END IF;
  IF v_saved_payload IS DISTINCT FROM v_payload THEN
    RAISE EXCEPTION 'Idempotency key reused with different payload';
  END IF;

  RETURN QUERY SELECT v_order, TRUE;
END
$fn$;
