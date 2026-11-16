--
-- PostgreSQL database dump
--

\restrict vedAJljR9fKcxoGBtJSh5pRieEjpSy0u1gFgOgz6BsjTlheFKfZc8Ms0oj1I0Wv

-- Dumped from database version 17.8 (Debian 17.8-1.pgdg12+1)
-- Dumped by pg_dump version 17.8 (Debian 17.8-1.pgdg12+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


--
-- Name: agent_identity; Type: DOMAIN; Schema: public; Owner: -
--

CREATE DOMAIN public.agent_identity AS text
	CONSTRAINT agent_identity_check CHECK (((VALUE ~ '^[a-z][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)?$'::text) AND (length(VALUE) <= 200)));


--
-- Name: sha256_hex; Type: DOMAIN; Schema: public; Owner: -
--

CREATE DOMAIN public.sha256_hex AS text
	CONSTRAINT sha256_hex_check CHECK ((VALUE ~ '^[a-f0-9]{64}$'::text));


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: classifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.classifications (
    id text NOT NULL,
    item_id text NOT NULL,
    taxonomy_version integer NOT NULL,
    labels text[] NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    proposed_by public.agent_identity NOT NULL,
    proposed_at timestamp with time zone DEFAULT now() NOT NULL,
    committed_by public.agent_identity,
    committed_at timestamp with time zone,
    confidence double precision NOT NULL,
    rationale text DEFAULT ''::text NOT NULL,
    CONSTRAINT classifications_check CHECK ((((status = 'pending'::text) AND (committed_by IS NULL) AND (committed_at IS NULL)) OR ((status = 'committed'::text) AND (committed_by IS NOT NULL) AND (committed_at IS NOT NULL)))),
    CONSTRAINT classifications_confidence_check CHECK (((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))),
    CONSTRAINT classifications_id_check CHECK ((id ~ '^cr_cls_[A-Za-z0-9]+$'::text)),
    CONSTRAINT classifications_labels_check CHECK ((cardinality(labels) >= 1)),
    CONSTRAINT classifications_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'committed'::text]))),
    CONSTRAINT classifications_taxonomy_version_check CHECK ((taxonomy_version >= 1))
);


--
-- Name: corpora; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.corpora (
    id text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    taxonomy_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    CONSTRAINT corpora_id_check CHECK ((id ~ '^cr_corpus_[A-Za-z0-9]+$'::text)),
    CONSTRAINT corpora_name_check CHECK ((name ~ '^[a-z][a-z0-9-]*$'::text)),
    CONSTRAINT corpora_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'archived'::text]))),
    CONSTRAINT corpora_taxonomy_id_check CHECK ((taxonomy_id ~ '^cr_tax_[A-Za-z0-9]+$'::text))
);


--
-- Name: edges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.edges (
    id text NOT NULL,
    from_id text NOT NULL,
    to_id text NOT NULL,
    to_system text DEFAULT 'corpus-ranker'::text NOT NULL,
    edge_type text NOT NULL,
    created_by public.agent_identity NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    evidence jsonb,
    provenance jsonb,
    reversed_at timestamp with time zone,
    reversed_by public.agent_identity,
    CONSTRAINT edges_check CHECK (((to_system <> 'corpus-ranker'::text) OR (to_id ~ '^cr_(corpus|tax|orig|item|cls|edge|pol|score|view|tomb)_[A-Za-z0-9]+$'::text))),
    CONSTRAINT edges_check1 CHECK (((reversed_at IS NULL) = (reversed_by IS NULL))),
    CONSTRAINT edges_edge_type_check CHECK ((edge_type = ANY (ARRAY['cites'::text, 'derived_from'::text, 'same_as'::text, 'supersedes'::text, 'evidences'::text, 'classified_under'::text, 'part_of'::text, 'artifact'::text]))),
    CONSTRAINT edges_evidence_check CHECK (((evidence IS NULL) OR (jsonb_typeof(evidence) = 'object'::text))),
    CONSTRAINT edges_from_id_check CHECK ((from_id ~ '^cr_(corpus|tax|orig|item|cls|edge|pol|score|view|tomb)_[A-Za-z0-9]+$'::text)),
    CONSTRAINT edges_id_check CHECK ((id ~ '^cr_edge_[A-Za-z0-9]+$'::text)),
    CONSTRAINT edges_provenance_check CHECK (((provenance IS NULL) OR (jsonb_typeof(provenance) = 'object'::text))),
    CONSTRAINT edges_to_id_check CHECK ((length(to_id) > 0)),
    CONSTRAINT edges_to_system_check CHECK ((to_system = ANY (ARRAY['corpus-ranker'::text, 'loop-closer'::text])))
);


--
-- Name: embeddings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.embeddings (
    item_id text NOT NULL,
    chunk_id text,
    embedding_model_id text NOT NULL,
    model_version text NOT NULL,
    dims integer NOT NULL,
    vector public.vector NOT NULL,
    built_at timestamp with time zone DEFAULT now() NOT NULL,
    source_hash public.sha256_hex NOT NULL,
    CONSTRAINT embeddings_check CHECK ((public.vector_dims(vector) = dims)),
    CONSTRAINT embeddings_chunk_id_check CHECK (((chunk_id IS NULL) OR (length(chunk_id) > 0))),
    CONSTRAINT embeddings_dims_check CHECK ((dims >= 1)),
    CONSTRAINT embeddings_embedding_model_id_check CHECK ((length(embedding_model_id) > 0)),
    CONSTRAINT embeddings_model_version_check CHECK ((length(model_version) > 0))
);


--
-- Name: item_originals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.item_originals (
    item_id text NOT NULL,
    original_id text NOT NULL
);


--
-- Name: items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.items (
    id text NOT NULL,
    corpus_id text NOT NULL,
    item_type text NOT NULL,
    title text NOT NULL,
    summary text,
    canonical_fields jsonb DEFAULT '{}'::jsonb NOT NULL,
    identity_keys jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT items_canonical_fields_check CHECK ((jsonb_typeof(canonical_fields) = 'object'::text)),
    CONSTRAINT items_id_check CHECK ((id ~ '^cr_item_[A-Za-z0-9]+$'::text)),
    CONSTRAINT items_identity_keys_check CHECK ((jsonb_typeof(identity_keys) = 'object'::text)),
    CONSTRAINT items_item_type_check CHECK ((item_type ~ '^[a-z][a-z0-9_-]*$'::text)),
    CONSTRAINT items_status_check CHECK ((status = ANY (ARRAY['active'::text, 'merged'::text, 'superseded'::text, 'tombstoned'::text]))),
    CONSTRAINT items_title_check CHECK ((length(title) > 0))
);


--
-- Name: originals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.originals (
    id text NOT NULL,
    corpus_id text NOT NULL,
    content_hash public.sha256_hex NOT NULL,
    media_type text NOT NULL,
    byte_size bigint NOT NULL,
    storage_uri text NOT NULL,
    source jsonb NOT NULL,
    raw_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    tombstoned_at timestamp with time zone,
    tombstone_reason text,
    CONSTRAINT originals_byte_size_check CHECK ((byte_size >= 0)),
    CONSTRAINT originals_check CHECK ((((tombstoned_at IS NULL) AND (tombstone_reason IS NULL)) OR ((tombstoned_at IS NOT NULL) AND (length(tombstone_reason) > 0)))),
    CONSTRAINT originals_id_check CHECK ((id ~ '^cr_orig_[A-Za-z0-9]+$'::text)),
    CONSTRAINT originals_media_type_check CHECK ((media_type ~ '^[a-z]+/[a-zA-Z0-9.+_-]+$'::text)),
    CONSTRAINT originals_raw_metadata_check CHECK ((jsonb_typeof(raw_metadata) = 'object'::text)),
    CONSTRAINT originals_source_check CHECK ((jsonb_typeof(source) = 'object'::text))
);


--
-- Name: policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.policies (
    id text NOT NULL,
    version integer NOT NULL,
    name text NOT NULL,
    corpus_id text NOT NULL,
    dimensions jsonb NOT NULL,
    judge_config jsonb NOT NULL,
    composite_rule jsonb NOT NULL,
    created_by public.agent_identity NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    supersedes_version integer,
    CONSTRAINT policies_check CHECK (((supersedes_version >= 1) AND (supersedes_version < version))),
    CONSTRAINT policies_composite_rule_check CHECK ((jsonb_typeof(composite_rule) = 'object'::text)),
    CONSTRAINT policies_dimensions_check CHECK (((jsonb_typeof(dimensions) = 'array'::text) AND (jsonb_array_length(dimensions) >= 1))),
    CONSTRAINT policies_id_check CHECK ((id ~ '^cr_pol_[A-Za-z0-9]+$'::text)),
    CONSTRAINT policies_judge_config_check CHECK ((jsonb_typeof(judge_config) = 'object'::text)),
    CONSTRAINT policies_name_check CHECK ((name ~ '^[a-z][a-z0-9-]*$'::text)),
    CONSTRAINT policies_version_check CHECK ((version >= 1))
);


--
-- Name: ranked_view_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ranked_view_actions (
    id bigint NOT NULL,
    view_id text NOT NULL,
    item_id text NOT NULL,
    action_type text NOT NULL,
    actor public.agent_identity NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ranked_view_actions_action_type_check CHECK ((action_type = ANY (ARRAY['picked'::text, 'promoted'::text, 'pursued'::text, 'rejected'::text])))
);


--
-- Name: ranked_view_actions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.ranked_view_actions ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.ranked_view_actions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: ranked_view_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ranked_view_entries (
    view_id text NOT NULL,
    rank integer NOT NULL,
    item_id text NOT NULL,
    composite double precision NOT NULL,
    score_event_ids text[] NOT NULL,
    CONSTRAINT ranked_view_entries_rank_check CHECK ((rank >= 1)),
    CONSTRAINT ranked_view_entries_score_event_ids_check CHECK ((cardinality(score_event_ids) >= 1))
);


--
-- Name: ranked_views; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ranked_views (
    id text NOT NULL,
    name text NOT NULL,
    corpus_id text NOT NULL,
    policy_id text NOT NULL,
    policy_version integer NOT NULL,
    query jsonb NOT NULL,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    stale boolean DEFAULT false NOT NULL,
    stale_reason text,
    CONSTRAINT ranked_views_check CHECK ((((NOT stale) AND (stale_reason IS NULL)) OR (stale AND (length(stale_reason) > 0)))),
    CONSTRAINT ranked_views_id_check CHECK ((id ~ '^cr_view_[A-Za-z0-9]+$'::text)),
    CONSTRAINT ranked_views_name_check CHECK ((length(name) > 0)),
    CONSTRAINT ranked_views_query_check CHECK (((jsonb_typeof(query) = 'object'::text) AND (query <> '{}'::jsonb)))
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version integer NOT NULL,
    name text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: score_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.score_events (
    id text NOT NULL,
    item_id text NOT NULL,
    policy_id text NOT NULL,
    policy_version integer NOT NULL,
    dimension_scores jsonb NOT NULL,
    scorer jsonb NOT NULL,
    scored_at timestamp with time zone NOT NULL,
    source_blind boolean NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT score_events_dimension_scores_check CHECK (((jsonb_typeof(dimension_scores) = 'array'::text) AND (jsonb_array_length(dimension_scores) >= 1))),
    CONSTRAINT score_events_id_check CHECK ((id ~ '^cr_score_[A-Za-z0-9]+$'::text)),
    CONSTRAINT score_events_scorer_check CHECK (((jsonb_typeof(scorer) = 'object'::text) AND (scorer ? 'identity'::text)))
);


--
-- Name: score_retractions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.score_retractions (
    score_event_id text NOT NULL,
    retracted_at timestamp with time zone DEFAULT now() NOT NULL,
    retracted_by public.agent_identity NOT NULL,
    retraction_reason text NOT NULL,
    CONSTRAINT score_retractions_retraction_reason_check CHECK ((length(retraction_reason) > 0))
);


--
-- Name: score_events_with_retraction; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.score_events_with_retraction AS
 SELECT s.id,
    s.item_id,
    s.policy_id,
    s.policy_version,
    s.dimension_scores,
    s.scorer,
    s.scored_at,
    s.source_blind,
    r.retracted_at,
    r.retracted_by,
    r.retraction_reason
   FROM (public.score_events s
     LEFT JOIN public.score_retractions r ON ((r.score_event_id = s.id)));


--
-- Name: tombstones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tombstones (
    id text NOT NULL,
    target_id text NOT NULL,
    reason text NOT NULL,
    actor public.agent_identity NOT NULL,
    tombstoned_at timestamp with time zone DEFAULT now() NOT NULL,
    preserved jsonb DEFAULT '[]'::jsonb NOT NULL,
    tombstoned_item_ids text[] DEFAULT '{}'::text[] NOT NULL,
    stale_view_ids text[] DEFAULT '{}'::text[] NOT NULL,
    CONSTRAINT tombstones_id_check CHECK ((id ~ '^cr_tomb_[A-Za-z0-9]+$'::text)),
    CONSTRAINT tombstones_preserved_check CHECK ((jsonb_typeof(preserved) = 'array'::text)),
    CONSTRAINT tombstones_reason_check CHECK ((length(reason) > 0)),
    CONSTRAINT tombstones_target_id_check CHECK ((target_id ~ '^cr_(orig|item)_[A-Za-z0-9]+$'::text))
);


--
-- Data for Name: classifications; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.classifications (id, item_id, taxonomy_version, labels, status, proposed_by, proposed_at, committed_by, committed_at, confidence, rationale) FROM stdin;
cr_cls_c1	cr_item_p1	1	{research/context-management}	committed	agent:classifier	2026-11-04 00:00:00+00	joe	2026-11-04 01:00:00+00	0.82	Agent memory.
\.


--
-- Data for Name: corpora; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.corpora (id, name, description, taxonomy_id, created_at, status) FROM stdin;
cr_corpus_funding	funding	Investors and funding opportunities. Item types: program (a grant, fellowship, accelerator or other funding program) and investor.	cr_tax_funding1	2026-11-16 04:16:35.005689+00	active
cr_corpus_papers01	papers	AI papers	cr_tax_papers01	2026-11-01 00:00:00+00	active
\.


--
-- Data for Name: edges; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.edges (id, from_id, to_id, to_system, edge_type, created_by, created_at, evidence, provenance, reversed_at, reversed_by) FROM stdin;
cr_edge_e1	cr_item_p1	cr_item_p2	corpus-ranker	cites	agent:citation-extractor	2026-11-07 11:00:00+00	{"id": "cr_orig_a1", "span": {"end": 20, "start": 10}}	\N	\N	\N
cr_edge_e2	cr_item_p1	lc_loop_42	loop-closer	evidences	joe	2026-11-07 12:00:00+00	\N	\N	\N	\N
cr_edge_e3	cr_item_p2	cr_item_p1	corpus-ranker	same_as	agent:dedup	2026-11-07 12:00:00+00	\N	\N	2026-11-07 13:00:00+00	joe
\.


--
-- Data for Name: item_originals; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.item_originals (item_id, original_id) FROM stdin;
cr_item_p1	cr_orig_a1
cr_item_p1	cr_orig_b2
cr_item_p2	cr_orig_c3
\.


--
-- Data for Name: items; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.items (id, corpus_id, item_type, title, summary, canonical_fields, identity_keys, status, created_at, updated_at) FROM stdin;
cr_item_p1	cr_corpus_papers01	paper	Context "Management" for Long-Horizon Agents	Line one.\nLine two — with ünïcode and a back\\slash.	{"authors": ["A. Author"]}	{"arxiv_id": "2611.01234"}	active	2026-11-03 08:00:00+00	2026-11-05 12:30:00.123456+00
cr_item_p2	cr_corpus_papers01	paper	Paper\tTwo	\N	{}	{"arxiv_id": "2611.02345"}	tombstoned	2026-11-06 00:00:00+00	2026-11-08 10:00:00+00
\.


--
-- Data for Name: originals; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.originals (id, corpus_id, content_hash, media_type, byte_size, storage_uri, source, raw_metadata, captured_at, tombstoned_at, tombstone_reason) FROM stdin;
cr_orig_a1	cr_corpus_papers01	aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa	application/pdf	10	s3://ranker-originals/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa	{"at": "2026-11-03T08:00:00Z", "hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "source": "https://export.arxiv.org/rss/cs.AI", "recorded_by": "agent:intake-arxiv", "source_kind": "feed"}	{"arxiv_id": "2611.01234"}	2026-11-03 08:00:00+00	\N	\N
cr_orig_b2	cr_corpus_papers01	bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb	application/json	20	s3://ranker-originals/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb	{"at": "2026-11-05T12:30:00Z", "hash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "source": "https://arxiv.org/abs/2611.01234v2", "recorded_by": "joe", "source_kind": "url"}	{}	2026-11-05 12:30:00+00	\N	\N
cr_orig_c3	cr_corpus_papers01	cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc	application/pdf	30	s3://ranker-originals/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc	{"at": "2026-11-06T00:00:00Z", "source": "papers-2026-W45.jsonl", "recorded_by": "agent:import-jsonl", "source_kind": "upload"}	{}	2026-11-06 00:00:00+00	2026-11-08 10:00:00+00	verified forgetting requested by joe
\.


--
-- Data for Name: policies; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.policies (id, version, name, corpus_id, dimensions, judge_config, composite_rule, created_by, created_at, supersedes_version) FROM stdin;
cr_pol_funding	1	funding-fit	cr_corpus_funding	[{"name": "Fit", "scale": {"max": 5, "min": 1, "kind": "integer"}, "weight": 1, "definition": {"1": "No fit: the program or investor does not fund work like Joe's.", "2": "Weak fit: adjacent field or stage, a stretch to apply.", "3": "Plausible fit: eligible, but not what they usually fund.", "4": "Good fit: funds work like Joe's at Joe's stage.", "5": "Direct fit: funds exactly this kind of work, stage and applicant."}, "judge_instructions": "Score Fit from the program or investor's stated focus, eligibility and portfolio: how well it matches Joe's work and stage."}, {"name": "Timing", "scale": {"max": 5, "min": 1, "kind": "integer"}, "weight": 1, "definition": {"1": "Wrong time: Joe could not use or qualify for this now.", "2": "Early or late: it fits a different phase of the work.", "3": "Workable: the timing neither helps nor hurts.", "4": "Good timing: it fits where the work is now.", "5": "Ideal timing: it fits the work's current phase exactly."}, "judge_instructions": "Score Timing from the program or investor's cycle and the work's current phase: whether now is the right moment to pursue it."}, {"name": "Deadline", "scale": {"max": 5, "min": 1, "kind": "integer"}, "weight": 1, "definition": {"1": "Passed or impossible: no realistic way to apply in time.", "2": "Very tight: applying in time would displace other work.", "3": "Tight but feasible: enough time with focused effort.", "4": "Comfortable: ample time to prepare a strong application.", "5": "Open: rolling intake or a deadline far enough away to prepare well."}, "judge_instructions": "Score Deadline from the stated deadline or intake schedule: how much room there is to prepare a strong application."}, {"name": "Value", "scale": {"max": 5, "min": 1, "kind": "integer"}, "weight": 1, "definition": {"1": "Not worth the effort: the award or terms cost more than they give.", "2": "Low value: small relative to the effort or with heavy strings.", "3": "Moderate value: worth pursuing if the effort is small.", "4": "High value: meaningful money, access or credibility.", "5": "Exceptional value: changes what the work can do."}, "judge_instructions": "Score Value from the amount, terms and non-financial benefits relative to the effort of applying."}]	{"source_blind": false, "allowed_scorers": [{"kind": "human", "identity": "joe"}]}	{"method": "weighted_sum", "tie_breaks": ["Fit", "Timing", "Deadline", "Value"]}	joe	2026-11-16 00:00:00+00	\N
cr_pol_paper	1	paper-rubric	cr_corpus_papers01	[{"name": "Relevance", "scale": {"max": 5, "min": 1, "kind": "integer"}, "weight": 1, "definition": {"1": "No.", "5": "Yes."}, "judge_instructions": "Score it."}, {"name": "Technical Merit", "scale": {"max": 5, "min": 1, "kind": "integer"}, "weight": 1, "definition": {"1": "No.", "5": "Yes."}, "judge_instructions": "Score it."}]	{"source_blind": false, "allowed_scorers": [{"kind": "human", "identity": "joe"}]}	{"method": "weighted_sum", "tie_breaks": ["Relevance"]}	joe	2026-11-01 08:00:00+00	\N
cr_pol_paper	2	paper-rubric	cr_corpus_papers01	[{"name": "Relevance", "scale": {"max": 5, "min": 1, "kind": "integer"}, "weight": 1, "definition": {"1": "No.", "5": "Yes."}, "judge_instructions": "Score it."}, {"name": "Technical Merit", "scale": {"max": 5, "min": 1, "kind": "integer"}, "weight": 1, "definition": {"1": "No.", "5": "Yes."}, "judge_instructions": "Score it."}]	{"source_blind": false, "allowed_scorers": [{"kind": "human", "identity": "joe"}]}	{"method": "weighted_sum", "tie_breaks": ["Relevance"]}	joe	2026-11-02 08:00:00+00	1
\.


--
-- Data for Name: ranked_view_actions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.ranked_view_actions (id, view_id, item_id, action_type, actor, at) FROM stdin;
1	cr_view_v1	cr_item_p1	picked	joe	2026-11-09 03:00:00+00
\.


--
-- Data for Name: ranked_view_entries; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.ranked_view_entries (view_id, rank, item_id, composite, score_event_ids) FROM stdin;
cr_view_v1	1	cr_item_p1	9	{cr_score_s1}
\.


--
-- Data for Name: ranked_views; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.ranked_views (id, name, corpus_id, policy_id, policy_version, query, computed_at, stale, stale_reason) FROM stdin;
cr_view_v1	daily-top-papers	cr_corpus_papers01	cr_pol_paper	1	{"subject": "agent context management"}	2026-11-09 02:00:00+00	t	Policy paper-rubric v2 created.
\.


--
-- Data for Name: schema_migrations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.schema_migrations (version, name, applied_at) FROM stdin;
1	corpus_model	2026-11-16 04:16:34.865101+00
2	funding_corpus	2026-11-16 04:16:35.005689+00
\.


--
-- Data for Name: score_events; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.score_events (id, item_id, policy_id, policy_version, dimension_scores, scorer, scored_at, source_blind, recorded_at) FROM stdin;
cr_score_s1	cr_item_p1	cr_pol_paper	1	[{"value": 5, "reason": "On target.", "evidence": [], "dimension": "Relevance"}, {"value": 4, "reason": "Solid.", "evidence": [], "dimension": "Technical Merit"}]	{"identity": "joe"}	2026-10-10 00:00:00+00	f	2026-11-09 00:00:00+00
cr_score_s2	cr_item_p1	cr_pol_paper	1	[{"value": 1, "reason": "Wrong PDF.", "evidence": [], "dimension": "Relevance"}, {"value": 1, "reason": "Wrong PDF.", "evidence": [], "dimension": "Technical Merit"}]	{"model": "claude-opus-5-5", "identity": "program:paper-judge"}	2026-10-11 00:00:00+00	t	2026-11-09 00:00:01+00
cr_score_s3	cr_item_p1	cr_pol_paper	2	[{"value": 4, "reason": "Replayed.", "evidence": [], "dimension": "Relevance"}, {"value": 4, "reason": "Replayed.", "evidence": [], "dimension": "Technical Merit"}]	{"identity": "joe"}	2026-11-09 00:00:00+00	f	2026-11-09 00:00:02+00
\.


--
-- Data for Name: score_retractions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.score_retractions (score_event_id, retracted_at, retracted_by, retraction_reason) FROM stdin;
cr_score_s2	2026-11-09 01:00:00+00	joe	Judge read the wrong PDF.
\.


--
-- Data for Name: tombstones; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.tombstones (id, target_id, reason, actor, tombstoned_at, preserved, tombstoned_item_ids, stale_view_ids) FROM stdin;
cr_tomb_t1	cr_orig_c3	verified forgetting requested by joe	joe	2026-11-08 10:00:00+00	[{"source": {"at": "2026-11-06T00:00:00Z", "source": "papers-2026-W45.jsonl", "recorded_by": "agent:import-jsonl", "source_kind": "upload"}, "original_id": "cr_orig_c3", "content_hash": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}]	{cr_item_p2}	{}
\.


--
-- Name: ranked_view_actions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.ranked_view_actions_id_seq', 1, true);


--
-- Name: classifications classifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.classifications
    ADD CONSTRAINT classifications_pkey PRIMARY KEY (id);


--
-- Name: corpora corpora_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.corpora
    ADD CONSTRAINT corpora_name_key UNIQUE (name);


--
-- Name: corpora corpora_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.corpora
    ADD CONSTRAINT corpora_pkey PRIMARY KEY (id);


--
-- Name: edges edges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edges
    ADD CONSTRAINT edges_pkey PRIMARY KEY (id);


--
-- Name: embeddings embeddings_item_id_chunk_id_embedding_model_id_model_versio_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.embeddings
    ADD CONSTRAINT embeddings_item_id_chunk_id_embedding_model_id_model_versio_key UNIQUE NULLS NOT DISTINCT (item_id, chunk_id, embedding_model_id, model_version);


--
-- Name: item_originals item_originals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_originals
    ADD CONSTRAINT item_originals_pkey PRIMARY KEY (item_id, original_id);


--
-- Name: items items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_pkey PRIMARY KEY (id);


--
-- Name: originals originals_corpus_id_content_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.originals
    ADD CONSTRAINT originals_corpus_id_content_hash_key UNIQUE (corpus_id, content_hash);


--
-- Name: originals originals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.originals
    ADD CONSTRAINT originals_pkey PRIMARY KEY (id);


--
-- Name: policies policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policies
    ADD CONSTRAINT policies_pkey PRIMARY KEY (id, version);


--
-- Name: ranked_view_actions ranked_view_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ranked_view_actions
    ADD CONSTRAINT ranked_view_actions_pkey PRIMARY KEY (id);


--
-- Name: ranked_view_entries ranked_view_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ranked_view_entries
    ADD CONSTRAINT ranked_view_entries_pkey PRIMARY KEY (view_id, rank);


--
-- Name: ranked_view_entries ranked_view_entries_view_id_item_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ranked_view_entries
    ADD CONSTRAINT ranked_view_entries_view_id_item_id_key UNIQUE (view_id, item_id);


--
-- Name: ranked_views ranked_views_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ranked_views
    ADD CONSTRAINT ranked_views_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: score_events score_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.score_events
    ADD CONSTRAINT score_events_pkey PRIMARY KEY (id);


--
-- Name: score_retractions score_retractions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.score_retractions
    ADD CONSTRAINT score_retractions_pkey PRIMARY KEY (score_event_id);


--
-- Name: tombstones tombstones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tombstones
    ADD CONSTRAINT tombstones_pkey PRIMARY KEY (id);


--
-- Name: classifications_item_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX classifications_item_idx ON public.classifications USING btree (item_id);


--
-- Name: edges_from_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX edges_from_idx ON public.edges USING btree (from_id, edge_type);


--
-- Name: edges_to_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX edges_to_idx ON public.edges USING btree (to_id, edge_type);


--
-- Name: embeddings_model_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX embeddings_model_idx ON public.embeddings USING btree (embedding_model_id, model_version);


--
-- Name: item_originals_original_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX item_originals_original_idx ON public.item_originals USING btree (original_id);


--
-- Name: items_corpus_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX items_corpus_idx ON public.items USING btree (corpus_id, item_type);


--
-- Name: items_identity_keys_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX items_identity_keys_idx ON public.items USING gin (identity_keys jsonb_path_ops);


--
-- Name: ranked_view_actions_view_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ranked_view_actions_view_idx ON public.ranked_view_actions USING btree (view_id);


--
-- Name: score_events_item_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX score_events_item_idx ON public.score_events USING btree (item_id, policy_id, policy_version);


--
-- Name: classifications classifications_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.classifications
    ADD CONSTRAINT classifications_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id);


--
-- Name: embeddings embeddings_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.embeddings
    ADD CONSTRAINT embeddings_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id) ON DELETE CASCADE;


--
-- Name: item_originals item_originals_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_originals
    ADD CONSTRAINT item_originals_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id);


--
-- Name: item_originals item_originals_original_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_originals
    ADD CONSTRAINT item_originals_original_id_fkey FOREIGN KEY (original_id) REFERENCES public.originals(id);


--
-- Name: items items_corpus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_corpus_id_fkey FOREIGN KEY (corpus_id) REFERENCES public.corpora(id);


--
-- Name: originals originals_corpus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.originals
    ADD CONSTRAINT originals_corpus_id_fkey FOREIGN KEY (corpus_id) REFERENCES public.corpora(id);


--
-- Name: policies policies_corpus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policies
    ADD CONSTRAINT policies_corpus_id_fkey FOREIGN KEY (corpus_id) REFERENCES public.corpora(id);


--
-- Name: policies policies_id_supersedes_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policies
    ADD CONSTRAINT policies_id_supersedes_version_fkey FOREIGN KEY (id, supersedes_version) REFERENCES public.policies(id, version);


--
-- Name: ranked_view_actions ranked_view_actions_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ranked_view_actions
    ADD CONSTRAINT ranked_view_actions_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id);


--
-- Name: ranked_view_actions ranked_view_actions_view_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ranked_view_actions
    ADD CONSTRAINT ranked_view_actions_view_id_fkey FOREIGN KEY (view_id) REFERENCES public.ranked_views(id);


--
-- Name: ranked_view_entries ranked_view_entries_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ranked_view_entries
    ADD CONSTRAINT ranked_view_entries_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id);


--
-- Name: ranked_view_entries ranked_view_entries_view_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ranked_view_entries
    ADD CONSTRAINT ranked_view_entries_view_id_fkey FOREIGN KEY (view_id) REFERENCES public.ranked_views(id);


--
-- Name: ranked_views ranked_views_corpus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ranked_views
    ADD CONSTRAINT ranked_views_corpus_id_fkey FOREIGN KEY (corpus_id) REFERENCES public.corpora(id);


--
-- Name: ranked_views ranked_views_policy_id_policy_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ranked_views
    ADD CONSTRAINT ranked_views_policy_id_policy_version_fkey FOREIGN KEY (policy_id, policy_version) REFERENCES public.policies(id, version);


--
-- Name: score_events score_events_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.score_events
    ADD CONSTRAINT score_events_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id);


--
-- Name: score_events score_events_policy_id_policy_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.score_events
    ADD CONSTRAINT score_events_policy_id_policy_version_fkey FOREIGN KEY (policy_id, policy_version) REFERENCES public.policies(id, version);


--
-- Name: score_retractions score_retractions_score_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.score_retractions
    ADD CONSTRAINT score_retractions_score_event_id_fkey FOREIGN KEY (score_event_id) REFERENCES public.score_events(id);


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO ranker_app;


--
-- Name: TABLE classifications; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.classifications TO ranker_app;


--
-- Name: TABLE corpora; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.corpora TO ranker_app;


--
-- Name: TABLE edges; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.edges TO ranker_app;


--
-- Name: TABLE embeddings; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.embeddings TO ranker_app;


--
-- Name: TABLE item_originals; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.item_originals TO ranker_app;


--
-- Name: TABLE items; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.items TO ranker_app;


--
-- Name: TABLE originals; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.originals TO ranker_app;


--
-- Name: TABLE policies; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.policies TO ranker_app;


--
-- Name: TABLE ranked_view_actions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.ranked_view_actions TO ranker_app;


--
-- Name: SEQUENCE ranked_view_actions_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT USAGE ON SEQUENCE public.ranked_view_actions_id_seq TO ranker_app;


--
-- Name: TABLE ranked_view_entries; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.ranked_view_entries TO ranker_app;


--
-- Name: TABLE ranked_views; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.ranked_views TO ranker_app;


--
-- Name: TABLE schema_migrations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.schema_migrations TO ranker_app;


--
-- Name: TABLE score_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.score_events TO ranker_app;


--
-- Name: TABLE score_retractions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.score_retractions TO ranker_app;


--
-- Name: TABLE score_events_with_retraction; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.score_events_with_retraction TO ranker_app;


--
-- Name: TABLE tombstones; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.tombstones TO ranker_app;


--
-- PostgreSQL database dump complete
--

\unrestrict vedAJljR9fKcxoGBtJSh5pRieEjpSy0u1gFgOgz6BsjTlheFKfZc8Ms0oj1I0Wv

