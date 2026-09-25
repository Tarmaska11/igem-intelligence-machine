# -*- coding: utf-8 -*-
"""Turn the LLM-extracted facet values into a filter list a person can actually use.

The summaries spell the same thing many ways ("Gel electrophoresis", "gel
electrophoresis", "Agarose gel electrophoresis"), so the raw values make a filter
sidebar that looks random. All of this runs at build time.
"""
import re

GREEK = {
    "α": "alpha", "β": "beta", "γ": "gamma", "δ": "delta",
    "μ": "u", "µ": "u", "’": "'",
}


def norm(s):
    s = (s or "").strip().lower()
    for a, b in GREEK.items():
        s = s.replace(a, b)
    s = re.sub(r"\([^)]*\)", " ", s)
    s = re.sub(r"[_/,;:]+", " ", s)
    s = re.sub(r"[^a-z0-9+\-. ]", " ", s)
    return re.sub(r"\s+", " ", s).strip(" .-")


# Values that carry no information. Dropped entirely.
JUNK = re.compile(
    r"^(n/?a|none|not specified|not mentioned|unknown|unspecified|other|various|"
    r"multiple|several|general|tbd|-+|misc\w*|none explicitly mentioned|water|"
    r"no\b.*(mention|specif)\w*|.*not (applicable|available).*)$"
)

# Each rule is (label, regex over the normalised value). First match wins, so the
# specific ones go above the general ones.

DOMAIN = [
    ("Biosensors",               r"biosens|biensing|sensing"),
    ("Diagnostics",              r"diagnos|detection|screening"),
    ("Therapeutics",             r"therapeut|biologic|oncolog|medicin|biomedical|drug|vaccine"),
    ("Bioremediation",           r"bioremediat|environment|pollut|waste|water treat"),
    ("Biomanufacturing",         r"biomanufact|manufactur|fermentat|bioproduct|biosynth|biotechnolog"),
    ("Biomaterials",             r"biomaterial|material"),
    ("Foundational tools",       r"foundational|tool|software|hardware|computational|modell?ing"),
    ("Agriculture & food",       r"agricultur|food|nutrition|crop|biopesticide|farming"),
    ("Energy",                   r"energy|biofuel|fuel"),
    ("Education & outreach",     r"education|outreach|policy|practice"),
    ("Biosafety & security",     r"biosafet|biosecur|biocontain"),
]

TECHNIQUE = [
    ("qPCR / RT-qPCR",           r"\b(q-?pcr|rt-?q?-?pcr|real.?time pcr|quantitative pcr)\b|reverse transcri"),
    ("Isothermal amplification", r"isothermal|recombinase polymerase|\brpa\b|rolling circle|\blamp\b"),
    ("PCR",                      r"\bpcr\b|polymerase chain reaction|primer design"),
    ("Gel electrophoresis",      r"electrophoresis"),
    ("SDS-PAGE",                 r"sds.?page|coomassie"),
    ("Western blot",             r"western blot"),
    ("ELISA",                    r"\belisa\b"),
    ("Flow cytometry",           r"flow cytometry|facs"),
    ("Gibson assembly",          r"gibson"),
    ("Golden Gate assembly",     r"golden gate"),
    ("BioBrick assembly",        r"biobrick|3a assembly"),
    ("Restriction digestion",    r"restriction|digest"),
    ("Ligation",                 r"\bligat|ligase"),
    ("Molecular cloning",        r"clon(e|ing)|plasmid construction|vector construction|^plasmids?$|recombinant dna|blue.?white"),
    ("Transformation",           r"transformation|heat.?shock|electroporation|conjugation|competent cell"),
    ("Transfection",             r"transfect|transduc|lentivir"),
    ("CRISPR",                   r"crispr|cas9|cas12|cas13|guide rna|\bgrna\b"),
    ("Site-directed mutagenesis", r"mutagenes"),
    ("Directed evolution",       r"directed evolution|phage display|\bselex\b"),
    ("Sequencing",               r"sequenc"),
    ("DNA / gene synthesis",     r"(dna|gene) synthesis"),
    ("Codon optimisation",       r"codon"),
    ("Homologous recombination", r"recombination|knock.?(in|out)"),
    ("RNA interference",         r"rna interference|\brnai\b|sirna|antisense"),
    ("Protein expression",       r"protein expression|recombinant protein|overexpress|induction|iptg|heterologous expression"),
    ("Protein purification",     r"purificat|chromatograph|affinity|ni-?nta"),
    ("Protein engineering",      r"protein engineering|enzyme engineering|rational design"),
    ("Genetic circuit design",   r"promoter engineering|genetic circuit|circuit design|logic gate|rbs engineering|rbs calculator"),
    ("Protein secretion & display", r"secretion|surface display|cell surface"),
    ("Lateral flow / paper tests", r"lateral flow|paper.?based|test strip"),
    ("Freeze-drying",            r"freeze.?dr|lyophili"),
    ("Software & web development", r"software|web ?development|app development|programming"),
    ("Spectroscopy & electrochemistry", r"spectroscop|light scattering|\bdls\b|voltammetr|electrochem|impedance|circular dichroism|\bnmr\b|raman|ftir"),
    ("Fluorescence microscopy",  r"fluorescen\w* microscop|confocal"),
    ("Electron microscopy",      r"electron microscop|\b(sem|tem)\b|atomic force"),
    ("Microscopy",               r"microscop"),
    ("Fluorescence assays",      r"fluorescen"),
    ("Spectrophotometry",        r"spectrophotom|od600|absorbance|plate reader|nanodrop"),
    ("Mass spectrometry",        r"mass spec|gc-?ms|lc-?ms|maldi"),
    ("Chromatography (HPLC/GC)", r"\bhplc\b|gas chromatograph|liquid chromatograph"),
    ("Cell culture & fermentation", r"cell culture|liquid culture|plating|streak|fermentat|bioreactor|bacterial culture|microbiolog|autoclav|steriliz|antibiotic selection|culturing"),
    ("Growth assays",            r"growth (curve|assay)|od measurement|viability|\bcfu\b|\bmtt\b|cck-?8|cytotox"),
    ("Enzyme assays",            r"enzyme (activity|assay)|kinetic|bradford|\bbca\b|colorimetric|biochemical assay|luciferase assay|luminescen"),
    ("Nucleic acid extraction",  r"miniprep|midiprep|maxiprep|(dna|rna|plasmid|gel) extraction|(plasmid|dna|rna) isolation"),
    ("Molecular docking",        r"docking"),
    ("Structure prediction",     r"alphafold|structure prediction|homology model|rosetta"),
    ("Molecular dynamics",       r"molecular dynamic|\bmd simulation"),
    ("Machine learning",         r"machine learning|deep learning|neural net"),
    ("Mathematical modelling",   r"model|simulat|flux balance|\bfba\b"),
    ("Bioinformatics",           r"bioinformatic|blast|alignment|genome assembly|data analysis"),
    ("Microfluidics",            r"microfluid"),
    ("3D printing",              r"3d print|additive manufact"),
    ("Optogenetics",             r"optogenet"),
    ("Quorum sensing",           r"quorum"),
    ("Cell-free systems",        r"cell.?free|tx-?tl|in vitro transcription"),
    ("Metabolic engineering",    r"metabolic engineering|pathway engineering"),
    ("Genetic engineering",      r"genetic (engineering|modification)|synthetic biology|molecular biology|genome editing"),
    ("Centrifugation & lysis",   r"centrifug|sonicat|lysis"),
]

CHASSIS = [
    ("E. coli",                  r"\be\.? ?coli\b|escherichia"),
    ("S. cerevisiae (yeast)",    r"cerevisiae|saccharomyces|\byeast\b"),
    ("P. pastoris (yeast)",      r"pastoris|komagataella"),
    ("Other yeast",              r"yarrowia|kluyveromyces|candida|schizosaccharomyces"),
    ("B. subtilis",              r"subtilis"),
    ("Lactic acid bacteria",     r"lactococcus|lactobacillus|lacticaseibacillus|\bl\.? lactis\b"),
    ("Pseudomonas",              r"pseudomonas"),
    ("Cyanobacteria",            r"synechocystis|synechococcus|cyanobact|anabaena"),
    ("Algae",                    r"chlamydomonas|chlorella|nannochloropsis|dunaliella|\balgae?\b|diatom"),
    ("Bacillus (other)",         r"bacillus"),
    ("Vibrio",                   r"vibrio"),
    ("Shewanella",               r"shewanella"),
    ("Agrobacterium / Rhizobium", r"agrobacterium|rhizobium"),
    ("Corynebacterium",          r"corynebact"),
    ("Salmonella / Listeria",    r"salmonella|listeria"),
    ("Mycobacterium",            r"mycobact"),
    ("Streptomyces",             r"streptomyces"),
    ("Clostridium",              r"clostridi"),
    ("HEK293",                   r"hek ?293"),
    ("CHO cells",                r"\bcho\b|chinese hamster"),
    ("HeLa",                     r"hela"),
    ("Mammalian cells (other)",  r"mammalian|human cell|huvec|\bmcf|u2os|jurkat|hepg2|thp-?1|macrophage|stem cell"),
    ("Plants",                   r"arabidopsis|nicotiana|tobacco|\bplant|oryza|zea mays|solanum"),
    ("Insects / nematodes",      r"drosophila|elegans|\bsf9\b|insect|bombyx"),
    ("Zebrafish / mouse",        r"zebrafish|danio|\bmouse\b|murine|\brat\b"),
    ("Fungi",                    r"aspergillus|trichoderma|pleurotus|ganoderma|\bfung(us|i)\b|penicillium"),
    ("Phage",                    r"phage|lambda"),
    ("Cell-free system",         r"cell.?free|tx-?tl"),
]

MOLECULE = [
    ("Heavy metals",             r"cadmium|\blead\b|mercury|arsenic|chromium|\bcopper\b|\bzinc\b|nickel|heavy metal|\b(pb|cd|hg|cu|zn|ni|cr) ?[1-6]?\+|^(pb|cd|hg)$"),
    ("Plastics (PET & micro)",   r"\bpet\b|polyethylene terephthalate|microplastic|plastic|terephthalic|ethylene glycol|polystyrene|polyurethane|\btpa\b|\bmhet\b"),
    ("Antibiotics",              r"antibiotic|penicillin|ampicillin|kanamycin|tetracyclin|chloramphenicol|vancomycin"),
    ("Pesticides & herbicides",  r"pesticide|herbicide|glyphosate|atrazine|organophosph|insecticide"),
    ("Fluorescent reporters",    r"\bgfp\b|\brfp\b|mcherry|sfgfp|egfp|\byfp\b|\bcfp\b|fluorescent protein|luciferase"),
    ("Greenhouse gases",         r"carbon dioxide|\bco2\b|methane|\bch4\b|nitrous oxide|greenhouse"),
    ("Nitrogen compounds",       r"nitrate|nitrite|ammoni|urea|nitrogen"),
    ("Phosphorus compounds",     r"phosphate|phosphorus"),
    ("Sugars & carbohydrates",   r"glucose|sucrose|lactose|xylose|arabinose|fructose|galactose|starch|cellulose|chitin|chitos|glycogen|carbohydrate|\bsugar"),
    ("Alcohols & solvents",      r"ethanol|methanol|butanol|glycerol|isopropanol|acetone|\bsolvent|aldehyde"),
    ("Lipids & oils",            r"lipid|triglycerid|fatty acid|^oils?$|(vegetable|cooking|plant|essential) oil"),
    ("Organic acids",            r"lactic acid|acetic acid|citric acid|succinic|butyric|organic acid|salicyl|formic|formate|uric acid"),
    ("Neurotransmitters",        r"serotonin|dopamine|l-?dopa|\bgaba\b|melatonin|acetylcholine|neurotransmitter"),
    ("Amino acids & peptides",   r"amino acid|tryptophan|tyrosine|glutamate|lysine|peptide|glutathione"),
    ("Nucleic acids",            r"^(dna|rna|mrna|sirna|trna|plasmid dna|cdna)$|nucleic acid|oligonucleotide|mirna|microrna"),
    ("Reactive oxygen species",  r"reactive oxygen|hydrogen peroxide|\bros\b|superoxide|free radical"),
    ("Hormones & steroids",      r"hormone|estrogen|insulin|testosterone|cortisol|steroid|auxin|cholesterol"),
    ("Signalling molecules",     r"\bahl\b|homoserine lactone|quorum|autoinducer|cyclic di|\bcamp\b|\batp\b"),
    ("Toxins & mycotoxins",      r"toxin|aflatoxin|ochratoxin|botulinum|\bricin"),
    ("Dyes & textile waste",     r"\bdye|azo\b|methylene blue|textile"),
    ("Pharmaceutical residues",  r"pharmaceutic|ibuprofen|paracetamol|acetaminophen|diclofenac|caffeine"),
    ("Terpenes & natural products", r"terpene|limonene|carot|lycopene|flavonoid|polyphenol|anthocyanin|natural product|indigo|vanillin|geraniol|naringenin|resveratrol|curcumin|violacein|astaxanthin"),
    ("Pathogens & biomarkers",   r"pathogen|bacteri|virus|sars|staphylococ|biomarker|antigen|pseudomonas|streptococc|escherichia|\be\.? ?coli\b|salmonella|listeria|helicobacter|candida|\bher2\b|tumou?r|cancer|biofilm|antibod"),
    ("Water pollutants (other)", r"pollutant|contaminant|effluent|wastewater|oil spill|petroleum|hydrocarbon|pfas|pfoa|pfos|perfluoro|toluene|benzene|phenol|catechol|alkane|\bbtex\b"),
    ("Physical stimuli",         r"^(light|blue light|red light|green light|near.?infrared( light)?|nir light|temperature|ph|heat|cold|pressure|uv|uv light|uv radiation|sound|ultrasound|magnetic field|electric field|electricity|electrons)$"),
    ("Inducers & signals",       r"\biptg\b|arabinose|nisin|anhydrotetracycline|\batc\b|inducer|\bahl\b"),
    ("Central metabolites",      r"lactate|acetate|pyruvate|butyrate|acetyl-?coa|\bnad[ph]*\b|succinate|malate|citrate"),
    ("Gases (O2/H2/H2S/NO)",     r"^(oxygen|hydrogen|hydrogen sulfide|nitric oxide|\bno\b|\bh2s?\b|\bo2\b|ozone)$|sulfide|sulphide"),
    ("Minerals & salts",         r"\biron\b|calcium|magnesium|potassium|sodium chloride|carbonate|silica|\bsalt\b|mineral"),
    ("Biopolymers & bioplastics", r"polyhydroxy|\bpha\b|\bphb\b|lignin|polyethylene|bioplastic|biopolymer|silk|collagen|keratin"),
    ("Proteins (generic)",       r"^(protein|proteins|enzyme|enzymes|gene expression|fluorescence|biomass)$"),
    ("Vitamins & cofactors",     r"vitamin|folic|folate|riboflavin|cofactor|biotin|heme"),
]

PART = [
    ("Reporter: GFP family",     r"\b(sf)?gfp\b|egfp|gfpmut|green fluorescent|amilgfp|mneongreen|superfolder|\bmgfp\b"),
    ("Reporter: RFP / mCherry",  r"\brfp\b|mcherry|mrfp|dsred|mscarlet|red fluorescent"),
    ("Reporter: other fluorescent", r"\b[ye]fp\b|\bcfp\b|\be[cyb]fp\b|\bbfp\b|mvenus|mturquoise|cerulean|citrine|mclover|morange|fluorescent protein"),
    ("Reporter: LacZ / luciferase", r"lacz|luciferase|\blux[ab]\b|galactosidase|chromoprotein|amilcp"),
    ("Promoter: T7",             r"\bt7\b"),
    ("Promoter: lac / tac",      r"\bp?lac\w*\b.*promoter|promoter.*lac|\bptac\b|\btrc\b|^p ?lac$|\blac ?operator\b|\blaco\b"),
    ("Promoter: tet",            r"\bp?tet\w*\b.*promoter|promoter.*tet|\bptet\b|\bteto\b|tet operator"),
    ("Promoter: ara / rha",      r"\bpbad\b|ara\w*.*promoter|rhamnose promoter"),
    ("Promoter: constitutive",   r"constitutive|j23\d{3}|anderson promoter"),
    ("Promoter: other",          r"promoter"),
    ("Ribosome binding site",    r"\brbs\b|ribosome binding|shine.?dalgarno|b0034|b0032"),
    ("Terminator",               r"terminator|b0015|b0010"),
    ("Regulator / repressor",    r"\blaci\b|\btetr\b|\barac\b|repressor|lambda ci|^ci\d*$|\bgal4\b|\blexa\b"),
    ("Regulator: quorum (Lux)",  r"\blux[ri]\b|\blas[ri]\b|\brhl[ri]\b|\bplux\b|lux operon|\baiia\b|quorum"),
    ("CRISPR: Cas / gRNA",       r"cas9|cas12|cas13|dcas9|\bs?grna\b|guide rna|crispr|crrna"),
    ("Affinity tag",             r"his.?tag|6x?his|\bflag\b|\bmbp\b|\bgst\b|strep.?tag|sumo|\bha.?tag|myc.?tag"),
    ("Signal peptide / secretion", r"signal peptide|secretion|pelb|ompa|tat pathway|\bhly[abd]\b"),
    ("Plasmid backbone",         r"psb\w+|\bpet-?\d|pet ?duet|pcold|pgex|\bpuc\d|pcdf|prsf|pacyc|backbone|\bvector\b|plasmid"),
    ("Restriction enzyme",       r"ecori|psti|xbai|spei|bsai|bsmbi|noti|bamhi|hindiii|ndei|xhoi|restriction enzyme"),
    ("Antimicrobial peptide",    r"ll-?37|nisin|antimicrobial peptide|defensin|bacteriocin|endolysin"),
    ("Enzyme: PETase / MHETase", r"petase|mhetase|cutinase"),
    ("Enzyme: laccase / peroxidase", r"laccase|peroxidase|\bp450\b|monooxygenase|dioxygenase"),
    ("Enzyme: cellulase / amylase", r"cellulase|amylase|xylanase|lipase|protease|chitinase"),
    ("Toxin / kill switch",      r"\bmazf\b|\bmaze\b|\bccdb\b|\bsacb\b|kill switch|toxin.?antitoxin|\brelbe\b|\bmerr\b"),
    ("Enzyme: other",            r"enzyme|\w+ase\b"),
    ("Binding protein / antibody", r"antibody|nanobody|scfv|aptamer|binding protein|receptor|streptavidin|avidin"),
    ("Riboswitch / sRNA",        r"riboswitch|ribozyme|\bsrna\b|aptazyme|toehold|sirna|shrna"),
    ("Degradation tag",          r"\bssra\b|degradation tag|\blva\b"),
    ("Origin of replication",    r"\bori\b|origin of replication|cole1|p15a"),
    ("Selection marker",         r"resistance|\bamp[r]?\b|\bkan[r]?\b|selection marker|\bura3\b|\bleu2\b|\bhis3\b|auxotroph"),
    ("Protein conjugation (Spy)", r"spytag|spycatcher|sortase|\bintein"),
    ("Recombinase site (lox/FRT)", r"\bloxp\b|\bfrt\b|recombinase|\bcre\b"),
    ("Inducer molecule",         r"^(iptg|ahl|arabinose|atc|anhydrotetracycline|biotin)$"),
    ("Registry / BioBrick part", r"^bba[ _-]?[a-z]?\d+|^biobricks?$"),
]

# The team CSVs give regions as slugs and countries as ISO-3 codes. These are the
# 67 countries that actually appear, spelled the way a reader expects.
REGION_LABEL = {
    "asia": "Asia", "north-america": "North America", "europe": "Europe",
    "latin-america": "Latin America", "oceania": "Oceania", "africa": "Africa",
}
SECTION_LABEL = {
    "undergrad": "Undergraduate", "overgrad": "Overgraduate", "high-school": "High school",
}
COUNTRY_LABEL = {
    "ARE": "United Arab Emirates", "ARG": "Argentina", "AUS": "Australia", "AUT": "Austria",
    "BEL": "Belgium", "BGR": "Bulgaria", "BOL": "Bolivia", "BRA": "Brazil", "CAN": "Canada",
    "CHE": "Switzerland", "CHL": "Chile", "CHN": "China", "COD": "DR Congo", "COL": "Colombia",
    "CRI": "Costa Rica", "CZE": "Czechia", "DEU": "Germany", "DNK": "Denmark", "ECU": "Ecuador",
    "EGY": "Egypt", "ESP": "Spain", "EST": "Estonia", "FIN": "Finland", "FRA": "France",
    "GBR": "United Kingdom", "GHA": "Ghana", "GRC": "Greece", "HKG": "Hong Kong",
    "HND": "Honduras", "HUN": "Hungary", "IDN": "Indonesia", "IND": "India", "IRL": "Ireland",
    "ISR": "Israel", "ITA": "Italy", "JPN": "Japan", "KAZ": "Kazakhstan", "KEN": "Kenya",
    "KOR": "South Korea", "KWT": "Kuwait", "LTU": "Lithuania", "LVA": "Latvia", "MAC": "Macau",
    "MEX": "Mexico", "NLD": "Netherlands", "NOR": "Norway", "NPL": "Nepal",
    "NZL": "New Zealand", "PAK": "Pakistan", "PAN": "Panama", "PER": "Peru", "POL": "Poland",
    "PRI": "Puerto Rico", "PRT": "Portugal", "QAT": "Qatar", "ROU": "Romania",
    "RUS": "Russia", "SAU": "Saudi Arabia", "SGP": "Singapore", "SVN": "Slovenia",
    "SWE": "Sweden", "THA": "Thailand", "TUR": "Turkey", "TWN": "Taiwan", "UGA": "Uganda",
    "USA": "United States", "ZAF": "South Africa",
}


def label_meta(kind, value):
    """Display label for a value that came straight from the iGEM team CSVs."""
    v = (value or "").strip()
    if kind == "region":
        return REGION_LABEL.get(v.lower(), v.replace("-", " ").title())
    if kind == "section":
        return SECTION_LABEL.get(v.lower(), v.replace("-", " ").capitalize())
    if kind == "country":
        return COUNTRY_LABEL.get(v.upper(), v)
    return v


RULES = {"domain": DOMAIN, "technique": TECHNIQUE, "chassis": CHASSIS,
         "molecule": MOLECULE, "part": PART}
_COMPILED = {k: [(label, re.compile(pat)) for label, pat in v] for k, v in RULES.items()}

_KEEP_UPPER = {"dna", "rna", "pcr", "gfp", "rfp", "hplc", "elisa", "crispr", "3d", "uv", "ph"}


def _title(s):
    words = [w.upper() if w in _KEEP_UPPER else w for w in s.split()]
    out = " ".join(words)
    return out[:1].upper() + out[1:]


# Answers that are true of every project, so they filter nothing.
GENERIC = {
    "chassis": {"synthetic biology"},
    "technique": {"experimental validation", "experimental design", "expression", "incubation"},
    "molecule": {"metabolites", "nutrients"},
    "part": {"reporter gene", "reporter genes", "linker", "linkers"},
}


def canon(kind, raw):
    """Canonical filter label for one raw facet value, or None to drop it."""
    n = norm(raw)
    if not n or len(n) > 90 or JUNK.match(n) or n in GENERIC.get(kind, ()):
        return None
    for label, rx in _COMPILED.get(kind, []):
        if rx.search(n):
            return label
    return _title(n)


# iGEM's own 15 villages (villages.igem.org). The team lists use the same
# column for the tracks teams chose before villages existed, so those are
# folded into the village they became; the vague ones go by the project's
# own application domain, and get no village if that says nothing either.
VILLAGES = {
    "Agriculture", "Art & Design", "Biomanufacturing", "Bioremediation",
    "Climate Crisis", "Conservation", "Diagnostics", "Fashion & Cosmetics",
    "Food & Nutrition", "Foundational Advance", "Infectious Diseases",
    "Oncology", "Software & AI", "Space", "Therapeutics",
}
OLD_TRACK = {
    "Health & Medicine": "Therapeutics",
    "Manufacturing": "Biomanufacturing",
    "Software": "Software & AI",
    "Energy": "Climate Crisis",
    "Information Processing": "Foundational Advance",
    "Measurement": "Foundational Advance",
    "Hardware": "Foundational Advance",
    "Microfluidics": "Foundational Advance",
}
DOMAIN_VILLAGE = {
    "Diagnostics": "Diagnostics",
    "Biosensors": "Diagnostics",
    "Biomanufacturing": "Biomanufacturing",
    "Biomaterials": "Biomanufacturing",
    "Bioremediation": "Bioremediation",
    "Therapeutics": "Therapeutics",
    "Foundational tools": "Foundational Advance",
    "Synthetic biology": "Foundational Advance",
    "Agriculture & food": "Agriculture",
    "Energy": "Climate Crisis",
}


def village(raw, domain):
    """The official village for a team's track or village, or "" if none fits."""
    v = (raw or "").strip()
    if v in VILLAGES:
        return v
    if v in OLD_TRACK:
        return OLD_TRACK[v]
    return DOMAIN_VILLAGE.get(domain or "", "")


# The model spells things a thousand ways, so most raw values belong to one team.
# A filter keeps its named groups, plus any other value at least this many teams share.
TAIL_KINDS = {"molecule", "technique", "part", "chassis"}
MIN_TEAMS = 10
RULE_LABELS = {k: {label for label, _ in v} for k, v in RULES.items()}


def keep_value(kind, label, n):
    """Whether a filter value is worth listing, given how many teams have it."""
    return kind not in TAIL_KINDS or label in RULE_LABELS.get(kind, ()) or n >= MIN_TEAMS
