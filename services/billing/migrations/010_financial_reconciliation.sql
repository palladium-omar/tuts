-- Additive canonical ledger. Source rows and original payment allocations remain intact.
DROP INDEX IF EXISTS billing_invoice_history_number_unique;
CREATE TABLE reconciliation_invoices (
 business_id uuid NOT NULL,id uuid NOT NULL,origin_kind text NOT NULL CHECK(origin_kind IN ('native','imported')),
 origin_id uuid NOT NULL,source_revision integer NOT NULL CHECK(source_revision>0),source_snapshot jsonb NOT NULL,
 payer_id uuid,currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 face_minor bigint NOT NULL CHECK(face_minor>=0 AND face_minor<=9007199254740991),
 declared_paid_minor bigint NOT NULL DEFAULT 0 CHECK(declared_paid_minor>=0 AND declared_paid_minor<=face_minor),
 status text NOT NULL CHECK(status IN ('draft','issued','settled')),invoice_date date NOT NULL,due_date date,service_month date,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(business_id,id),UNIQUE(business_id,origin_kind,origin_id),UNIQUE(business_id,id,currency),
 CHECK(status<>'draft' OR declared_paid_minor=0)
);
CREATE TABLE reconciliation_source_aliases (
 business_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('native','imported')),source_id uuid NOT NULL,
 source_revision integer NOT NULL CHECK(source_revision>0),source_snapshot jsonb NOT NULL,invoice_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(business_id,kind,source_id),
 FOREIGN KEY(business_id,invoice_id) REFERENCES reconciliation_invoices(business_id,id)
);
CREATE INDEX reconciliation_alias_invoice ON reconciliation_source_aliases(business_id,invoice_id);
CREATE TABLE reconciliation_beneficiaries (
 business_id uuid NOT NULL,invoice_id uuid NOT NULL,student_id uuid NOT NULL,
 PRIMARY KEY(business_id,invoice_id,student_id),FOREIGN KEY(business_id,invoice_id) REFERENCES reconciliation_invoices(business_id,id)
);
CREATE INDEX reconciliation_beneficiary_student ON reconciliation_beneficiaries(business_id,student_id);
CREATE TABLE reconciliation_work_coverage (
 business_id uuid NOT NULL,invoice_id uuid NOT NULL,work_id uuid NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>0 AND amount_minor<=9007199254740991),
 work_revision integer NOT NULL CHECK(work_revision>0),work_snapshot jsonb NOT NULL,
 work_amount_minor bigint NOT NULL CHECK(work_amount_minor>=0 AND work_amount_minor<=9007199254740991),
 work_status text NOT NULL CHECK(work_status IN ('unsent','pending','paid')),currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(business_id,invoice_id,work_id),CHECK(amount_minor<=work_amount_minor),
 FOREIGN KEY(business_id,invoice_id,currency) REFERENCES reconciliation_invoices(business_id,id,currency),
 FOREIGN KEY(business_id,work_id) REFERENCES billing_work_log(business_id,id)
);
CREATE INDEX reconciliation_coverage_work ON reconciliation_work_coverage(business_id,work_id);
CREATE TABLE reconciliation_receipts (
 business_id uuid NOT NULL,id uuid NOT NULL,payment_id uuid,source_invoice_id uuid,provider text NOT NULL CHECK(length(provider) BETWEEN 1 AND 40),
 connection_id uuid,provider_reference text NOT NULL CHECK(length(provider_reference) BETWEEN 1 AND 200),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),amount_minor bigint NOT NULL CHECK(amount_minor>0 AND amount_minor<=9007199254740991),
 paid_at timestamptz NOT NULL,evidence text NOT NULL CHECK(evidence IN ('provider','historical','simulated')),
 legacy boolean NOT NULL DEFAULT false,reason text NOT NULL DEFAULT '',revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(business_id,id),UNIQUE(business_id,id,currency),UNIQUE(business_id,payment_id),
 CHECK((evidence IN ('provider','simulated') AND payment_id IS NOT NULL AND source_invoice_id IS NOT NULL) OR (evidence='historical' AND payment_id IS NULL AND source_invoice_id IS NULL)),
 CHECK(legacy OR evidence='historical' OR connection_id IS NOT NULL)
);
CREATE UNIQUE INDEX reconciliation_provider_identity ON reconciliation_receipts(business_id,provider,connection_id,provider_reference) WHERE connection_id IS NOT NULL;
CREATE UNIQUE INDEX reconciliation_historical_identity ON reconciliation_receipts(business_id,provider_reference) WHERE evidence='historical';
CREATE TABLE reconciliation_receipt_aliases (
 business_id uuid NOT NULL,payment_id uuid NOT NULL,receipt_id uuid NOT NULL,
 PRIMARY KEY(business_id,payment_id),FOREIGN KEY(business_id,receipt_id) REFERENCES reconciliation_receipts(business_id,id)
);
CREATE TABLE reconciliation_allocations (
 business_id uuid NOT NULL,id uuid NOT NULL,receipt_id uuid NOT NULL,invoice_id uuid NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>0 AND amount_minor<=9007199254740991),currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 native_payment_id uuid,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(business_id,id),UNIQUE(business_id,native_payment_id),
 FOREIGN KEY(business_id,receipt_id,currency) REFERENCES reconciliation_receipts(business_id,id,currency),
 FOREIGN KEY(business_id,invoice_id,currency) REFERENCES reconciliation_invoices(business_id,id,currency)
);
CREATE INDEX reconciliation_allocation_invoice ON reconciliation_allocations(business_id,invoice_id);
CREATE INDEX reconciliation_allocation_receipt ON reconciliation_allocations(business_id,receipt_id);
CREATE TABLE reconciliation_adjustments (
 business_id uuid NOT NULL,id uuid NOT NULL,invoice_id uuid NOT NULL,receipt_id uuid,
 kind text NOT NULL CHECK(kind IN ('credit','refund')),amount_minor bigint NOT NULL CHECK(amount_minor>0 AND amount_minor<=9007199254740991),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
 occurred_on date NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(business_id,id),
 CHECK((kind='credit' AND receipt_id IS NULL) OR (kind='refund' AND receipt_id IS NOT NULL)),
 FOREIGN KEY(business_id,invoice_id,currency) REFERENCES reconciliation_invoices(business_id,id,currency),
 FOREIGN KEY(business_id,receipt_id,currency) REFERENCES reconciliation_receipts(business_id,id,currency)
);
CREATE INDEX reconciliation_adjustment_invoice ON reconciliation_adjustments(business_id,invoice_id);
CREATE INDEX reconciliation_adjustment_receipt ON reconciliation_adjustments(business_id,receipt_id);
CREATE TABLE reconciliation_audit (
 business_id uuid NOT NULL,id uuid NOT NULL,operation text NOT NULL,actor_id text NOT NULL,request_id text NOT NULL,
 details jsonb NOT NULL,subject_id uuid,request_hash text CHECK(request_hash IS NULL OR request_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(business_id,id)
);
CREATE UNIQUE INDEX reconciliation_publish_payload ON reconciliation_audit(business_id,operation,subject_id,request_hash) WHERE request_hash IS NOT NULL;
-- Every writer, including SQL/backfill writers, observes the same tenant lock and caps.
CREATE FUNCTION reconciliation_check_caps() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tenant uuid := NEW.business_id; face numeric; funds numeric; credits numeric; assigned numeric; refunded numeric; adjustment_kind text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('billing-reconciliation:' || tenant::text,0));
 SELECT face_minor INTO face FROM reconciliation_invoices WHERE business_id=tenant AND id=NEW.invoice_id FOR UPDATE;
 IF TG_TABLE_NAME='reconciliation_work_coverage' THEN
  SELECT coalesce(sum(amount_minor),0) INTO assigned FROM reconciliation_work_coverage WHERE business_id=tenant AND work_id=NEW.work_id AND invoice_id<>NEW.invoice_id;
  IF assigned+NEW.amount_minor>NEW.work_amount_minor THEN RAISE EXCEPTION 'reconciliation_work_coverage_exceeds_value' USING ERRCODE='23514'; END IF;
  SELECT coalesce(sum(amount_minor),0) INTO assigned FROM reconciliation_work_coverage WHERE business_id=tenant AND invoice_id=NEW.invoice_id AND work_id<>NEW.work_id;
  IF assigned+NEW.amount_minor>face THEN RAISE EXCEPTION 'reconciliation_invoice_coverage_exceeds_face' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT coalesce(sum(amount_minor),0) INTO credits FROM reconciliation_adjustments WHERE business_id=tenant AND invoice_id=NEW.invoice_id AND kind='credit' AND id<>NEW.id;
  SELECT coalesce(sum(amount_minor),0) INTO assigned FROM reconciliation_allocations WHERE business_id=tenant AND invoice_id=NEW.invoice_id AND id<>NEW.id;
  IF TG_TABLE_NAME='reconciliation_adjustments' THEN adjustment_kind := NEW.kind; END IF;
  IF adjustment_kind='credit' THEN
   IF credits+NEW.amount_minor+assigned>face THEN RAISE EXCEPTION 'reconciliation_credit_exceeds_payable' USING ERRCODE='23514'; END IF;
  ELSE
   SELECT amount_minor INTO funds FROM reconciliation_receipts WHERE business_id=tenant AND id=NEW.receipt_id FOR UPDATE;
   SELECT coalesce(sum(amount_minor),0) INTO refunded FROM reconciliation_adjustments WHERE business_id=tenant AND receipt_id=NEW.receipt_id AND kind='refund' AND id<>NEW.id;
   IF TG_TABLE_NAME='reconciliation_allocations' THEN
    IF NEW.amount_minor+assigned+credits>face THEN RAISE EXCEPTION 'reconciliation_allocation_exceeds_payable' USING ERRCODE='23514'; END IF;
    IF (SELECT status='draft' FROM reconciliation_invoices WHERE business_id=tenant AND id=NEW.invoice_id) THEN RAISE EXCEPTION 'reconciliation_invoice_not_issued' USING ERRCODE='23514'; END IF;
    SELECT coalesce(sum(amount_minor),0) INTO assigned FROM reconciliation_allocations WHERE business_id=tenant AND receipt_id=NEW.receipt_id AND id<>NEW.id;
    IF NEW.amount_minor+assigned>funds THEN RAISE EXCEPTION 'reconciliation_allocation_exceeds_receipt' USING ERRCODE='23514'; END IF;
   ELSE
    IF NEW.amount_minor+refunded>funds THEN RAISE EXCEPTION 'reconciliation_refund_exceeds_receipt' USING ERRCODE='23514'; END IF;
    IF NOT EXISTS(SELECT 1 FROM reconciliation_allocations WHERE business_id=tenant AND receipt_id=NEW.receipt_id AND invoice_id=NEW.invoice_id) THEN
     RAISE EXCEPTION 'reconciliation_refund_invoice_unallocated' USING ERRCODE='23514';
    END IF;
    SELECT coalesce(sum(amount_minor),0) INTO assigned FROM reconciliation_allocations WHERE business_id=tenant AND receipt_id=NEW.receipt_id AND invoice_id=NEW.invoice_id;
    IF NEW.amount_minor+(SELECT coalesce(sum(amount_minor),0) FROM reconciliation_adjustments WHERE business_id=tenant AND receipt_id=NEW.receipt_id AND invoice_id=NEW.invoice_id AND kind='refund' AND id<>NEW.id)>assigned THEN
     RAISE EXCEPTION 'reconciliation_refund_exceeds_invoice_receipt' USING ERRCODE='23514';
    END IF;
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER reconciliation_coverage_caps BEFORE INSERT OR UPDATE ON reconciliation_work_coverage FOR EACH ROW EXECUTE FUNCTION reconciliation_check_caps();
-- A reviewed work revision refreshes every linked invoice in one transaction.
-- Check snapshot agreement at commit, after all links have received that revision.
CREATE FUNCTION reconciliation_check_work_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM reconciliation_work_coverage WHERE business_id=NEW.business_id AND work_id=NEW.work_id
   GROUP BY work_id HAVING count(DISTINCT work_revision)>1 OR count(DISTINCT work_amount_minor)>1 OR count(DISTINCT work_status)>1 OR count(DISTINCT currency)>1 OR sum(amount_minor)>min(work_amount_minor)) THEN
  RAISE EXCEPTION 'reconciliation_work_snapshot_conflict' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER reconciliation_work_snapshot_consistency AFTER INSERT OR UPDATE ON reconciliation_work_coverage
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconciliation_check_work_snapshot();
CREATE TRIGGER reconciliation_allocation_caps BEFORE INSERT OR UPDATE ON reconciliation_allocations FOR EACH ROW EXECUTE FUNCTION reconciliation_check_caps();
CREATE TRIGGER reconciliation_adjustment_caps BEFORE INSERT OR UPDATE ON reconciliation_adjustments FOR EACH ROW EXECUTE FUNCTION reconciliation_check_caps();
CREATE FUNCTION reconciliation_protect_obligation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('billing-reconciliation:' || NEW.business_id::text,0));
 IF NEW.business_id<>OLD.business_id OR NEW.id<>OLD.id OR NEW.origin_kind<>OLD.origin_kind OR NEW.origin_id<>OLD.origin_id OR
  (OLD.status<>'draft' AND (NEW.face_minor<>OLD.face_minor OR NEW.currency<>OLD.currency OR NEW.declared_paid_minor<>OLD.declared_paid_minor OR NEW.source_snapshot IS DISTINCT FROM OLD.source_snapshot)) THEN
  RAISE EXCEPTION 'reconciliation_issued_obligation_immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.face_minor<(SELECT coalesce(sum(amount_minor),0) FROM reconciliation_work_coverage WHERE business_id=NEW.business_id AND invoice_id=NEW.id) OR
  NEW.face_minor<(SELECT coalesce(sum(amount_minor),0) FROM reconciliation_allocations WHERE business_id=NEW.business_id AND invoice_id=NEW.id)+
   (SELECT coalesce(sum(amount_minor),0) FROM reconciliation_adjustments WHERE business_id=NEW.business_id AND invoice_id=NEW.id AND kind='credit') THEN
  RAISE EXCEPTION 'reconciliation_invoice_face_below_reserved' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reconciliation_protect_obligation BEFORE UPDATE ON reconciliation_invoices FOR EACH ROW EXECUTE FUNCTION reconciliation_protect_obligation();
CREATE FUNCTION reconciliation_protect_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='reconciliation_receipts' THEN
  IF NEW.business_id<>OLD.business_id OR NEW.id<>OLD.id OR NEW.payment_id IS DISTINCT FROM OLD.payment_id OR NEW.source_invoice_id IS DISTINCT FROM OLD.source_invoice_id OR
    NEW.provider<>OLD.provider OR NEW.currency<>OLD.currency OR NEW.amount_minor<>OLD.amount_minor OR NEW.evidence<>OLD.evidence OR
    (NOT OLD.legacy AND (NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.provider_reference<>OLD.provider_reference OR NEW.paid_at<>OLD.paid_at OR NEW.legacy)) THEN
   RAISE EXCEPTION 'reconciliation_receipt_identity_immutable' USING ERRCODE='23514';
  END IF;
 ELSE
  IF NEW.business_id<>OLD.business_id OR NEW.kind<>OLD.kind OR NEW.source_id<>OLD.source_id OR NEW.invoice_id<>OLD.invoice_id OR
   (OLD.kind='imported' AND (NEW.source_revision<>OLD.source_revision OR NEW.source_snapshot IS DISTINCT FROM OLD.source_snapshot)) THEN
   RAISE EXCEPTION 'reconciliation_source_identity_immutable' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reconciliation_protect_receipt BEFORE UPDATE ON reconciliation_receipts FOR EACH ROW EXECUTE FUNCTION reconciliation_protect_identity();
CREATE TRIGGER reconciliation_protect_source BEFORE UPDATE ON reconciliation_source_aliases FOR EACH ROW EXECUTE FUNCTION reconciliation_protect_identity();
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['reconciliation_invoices','reconciliation_source_aliases','reconciliation_beneficiaries','reconciliation_work_coverage','reconciliation_receipts','reconciliation_receipt_aliases','reconciliation_allocations','reconciliation_adjustments','reconciliation_audit'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY %I ON %I USING (business_id=nullif(current_setting(''app.business_id'',true),'''')::uuid) WITH CHECK (business_id=nullif(current_setting(''app.business_id'',true),'''')::uuid)',name || '_tenant',name);
 END LOOP;
END $$;
