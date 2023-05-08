import { Ast, Syntax } from 'thingtalk';
import { I18n } from 'genie-toolkit';
import {  
    Parser, 
    SparqlParser,
    SelectQuery,
    AskQuery,
    Pattern,
    Expression,
    Grouping,
    Triple
} from 'sparqljs';
import {
    isFilterPattern,
    isBasicGraphPattern,
    isUnionPattern,
    isSelectQuery,
    isWikidataLabelServicePattern,
    isVariable
} from '../utils/sparqljs-typeguard';
import ConverterHelper from './helpers';
import { 
    getSpans,
    ArrayCollection
} from '../utils/misc';
import WikidataUtils from '../utils/wikidata';
import { WikiSchema as WikidataSchema } from '../schema';
import {
    makeProgram,
    baseQuery
} from '../utils/thingtalk';
import { PostProcessor } from './helpers/post-processor';
import { RuleBasedPreprocessor } from './helpers/rule-based-preprocessor';
import { PatternConverter } from './helpers/pattern-convertor';
import { PreprocessVisitor, PropertyPathFinder, PropertyPathOptimizer } from '../utils/sparqljs';


export class Projection {
    public property : string|Ast.PropertyPathSequence|Ast.FilterValue|Ast.ArrayFieldValue;
    public variable ?: string;
    public type ?: string;

    constructor(options : {
        property : string|Ast.PropertyPathSequence|Ast.FilterValue|Ast.ArrayFieldValue, 
        variable ?: string,
        type ?: string}
    ) {
        this.property = options.property;
        this.variable = options.variable;
        this.type = options.type;
    }

    public equals(other : Projection) : boolean {
        if (this.variable !== other.variable || this.type !== other.type)
            return false;


        if (typeof this.property === 'string')
            return this.property === other.property;

        if (Array.isArray(this.property)) {
            if (!Array.isArray(other.property))
                return false;
            for (const propertyPath of this.property) {
                if (!other.property.some((p) => p.equals(propertyPath)))
                    return false;
            }
            return true;
        } else {  
            if (typeof other.property === 'string' || Array.isArray(other.property))
                return false;
            return this.property.equals(other.property);
        }
    }
}

export class Aggregation {
    public op : string;
    public variable : string;

    constructor(options : { op : string, variable : string }) {
        this.op = options.op;
        this.variable = options.variable;
    }

    public equals(other : Aggregation) : boolean {
        return this.op === other.op && this.variable === other.variable;
    }
}

// comparison is used for making comparison between two tables
// lhs and rhs should be the variable name used for the comparison in SPARQL
export interface Comparison {
    lhs : string,
    operator : string, 
    rhs : string
}

export interface Predicate {
    table ?: string,
    property ?: string,
    op ?: string
    isVariable ?: boolean,
    value ?: string,
    predicate_variable ?: string,
    qualifiers : Qualifier[],
}

export interface Qualifier {
    property : string,
    op : string
    value : string,
    isVariable : boolean,
}

export interface Table {
    name : string,
    projections : Projection[],
    filters : Ast.BooleanExpression[]
}

class QueryParser {
    private _converter : SPARQLToThingTalkConverter;

    constructor(converter : SPARQLToThingTalkConverter) {
        this._converter = converter;
    }
    
    private async _parseWhere(clauses : Pattern[]) {
        const filtersBySubject = new ArrayCollection<Ast.BooleanExpression>();
        // (1) parse non-filters
        for (const clause of clauses.filter((clause) => clause.type !== 'filter')) 
            filtersBySubject.merge(await this._parseWhereClause(clause));
        // (2) parse filters
        for (const clause of clauses.filter((clause) => clause.type === 'filter')) 
            filtersBySubject.merge(await this._parseWhereClause(clause));
        // (3) parse qualifiers
        
        for (const [subject, filters] of filtersBySubject.iterate()) {
            for (const filter of filters) 
                this._converter.updateTable(subject, filter);
        }
    }

    private async _parseWhereClause(clause : Pattern) : Promise<ArrayCollection<Ast.BooleanExpression>> {
        if (isBasicGraphPattern(clause))
            return this._converter.helper.parseTriples(clause);
        if (isFilterPattern(clause)) 
            return this._converter.helper.parseFilter(clause);
        if (isUnionPattern(clause)) 
            return this._converter.helper.parseUnion(clause);
        if (isWikidataLabelServicePattern(clause))
            return this._converter.helper.parseWikidataLabel(clause);
        throw new Error(`Unsupported where clause ${JSON.stringify(clause)}`);
    }

    private async _parseHaving(group : Grouping[], having ?: Expression[]) {
        if (group.length > 1)
            throw new Error('Unsupported: group by with multiple fields');
        for (const clause of having ?? []) 
            await this._converter.helper.parseGroup(clause, group[0]);
    }

    private async _parsePredicates() {
        if (this._converter.helper.predicates.length === 0)
            return;
        
        const filtersBySubject = await this._converter.helper.convertPredicates();
        for (const [subject, filters] of filtersBySubject.iterate()) {
            for (const filter of filters)
                this._converter.updateTable(subject, filter);
        }
    }

    async parse(query : SelectQuery|AskQuery) {
        if (query.where) {
            await this._parseWhere(query.where);
            await this._parsePredicates();
        }

        if (isSelectQuery(query) && query.group)
            await this._parseHaving(query.group, query.having);
    }
}

class QueryGenerator {
    private _converter : SPARQLToThingTalkConverter;
    private _postprocessor : PostProcessor;

    constructor(converter : SPARQLToThingTalkConverter) {
        this._converter = converter;
        this._postprocessor = new PostProcessor(this._converter.kb, { abstractProperty: converter.abstractProperty });
    }

    private async _generateSelectQuery(query : SelectQuery) : Promise<Ast.Expression> {
        const projectionsAndAggregationsBySubject = this._converter.helper.parseVariables(query.variables);            
        await this._converter.helper.preprocessTables(projectionsAndAggregationsBySubject);
        const mainSubject = this._converter.helper.getMainSubject(query);
        const table = this._converter.tables[mainSubject];
        const filters = [...table.filters];
        const projections = projectionsAndAggregationsBySubject.get(mainSubject);
        for (const subject in this._converter.tables) {
            if (subject === mainSubject)
                continue;
            const projIndex = projections.findIndex((p) => p.variable === subject);
            // if subject matches a projection of the mainSubject, update the projection to be a filtered value
            // otherwise, add a subquery as filter
            if (projIndex !== -1)
                projections.splice(projIndex, 1, this._converter.helper.makeFilterValue(mainSubject, subject));
            else
                filters.push(this._converter.helper.makeSubquery(mainSubject, subject));
        }
        let expression : Ast.Expression = baseQuery(table.name);
        expression = this._converter.helper.addFilters(expression, filters);
        expression = this._converter.helper.addOrdering(expression, table, query.order);
        expression = this._converter.helper.addLimit(expression, query.limit, query.offset);
        expression = this._converter.helper.addProjectionsAndAggregations(expression, mainSubject, projections);
        return expression;
    }

    private _generateAskQuery(query : AskQuery) : Ast.Expression {
        const mainSubject = this._converter.helper.getMainSubject(query);
        const table = this._converter.tables[mainSubject];
        const filters : Ast.BooleanExpression[] = [...table.filters];
        for (const subject in this._converter.tables) {
            if (subject === mainSubject)
                continue;
            filters.push(this._converter.helper.makeSubquery(mainSubject, subject));
        }
        
        return this._converter.helper.addVerification(baseQuery(table.name), filters, table.projections);
    }

    async generate(query : SelectQuery|AskQuery) : Promise<Ast.Program> {
        const expression = isSelectQuery(query) ? (await this._generateSelectQuery(query)) : this._generateAskQuery(query);
        return this._postprocessor.postProcess(this._converter.utterance!, makeProgram(expression));
    }
}


interface SPARQLToThingTalkConverterOptions {
    cache : string;
    save_cache : boolean;
    bootleg_db : string;
    human_readable_instance_of : boolean;
    abstract_property : boolean;
}

export default class SPARQLToThingTalkConverter {
    private _sparqlParser : SparqlParser;
    private _class : Ast.ClassDef;
    private _schema : WikidataSchema;
    private _kb : WikidataUtils;
    private _preprocessor : RuleBasedPreprocessor;
    private _patternConverter : PatternConverter;
    private _helper : ConverterHelper;
    private _tokenizer : I18n.BaseTokenizer;
    private _utterance ?: string;
    private _sparql ?: string;
    private _keywords : string[];
    private _tables : Record<string, Table>;
    private _crossTableComparison : Comparison[];
    private _parser : QueryParser;
    private _generator : QueryGenerator;
    private _humanReadableInstanceOf : boolean;
    private _abstractProperty : boolean;

    constructor(classDef : Ast.ClassDef, options : SPARQLToThingTalkConverterOptions) {
        this._sparqlParser = new Parser();
        this._class = classDef;
        this._schema = new WikidataSchema(classDef);
        this._kb = new WikidataUtils(options.cache, options.bootleg_db, options.save_cache);
        this._preprocessor = new RuleBasedPreprocessor(this._kb);

        this._humanReadableInstanceOf = options.human_readable_instance_of;
        this._abstractProperty = options.abstract_property;

        this._patternConverter = new PatternConverter(this);
        this._helper = new ConverterHelper(this);
        this._tokenizer = new I18n.LanguagePack('en').getTokenizer();
        this._parser = new QueryParser(this);
        this._generator = new QueryGenerator(this);

        this._utterance = undefined;
        this._sparql = undefined;
        this._tables = {};
        this._crossTableComparison = [];
        this._keywords = [];
    } 

    get class() : Ast.ClassDef {
        return this._class;
    }
    
    get kb() : WikidataUtils {
        return this._kb;
    }

    get schema() : WikidataSchema {
        return this._schema;
    }

    get helper() : ConverterHelper {
        return this._helper;
    }

    get tables() : Record<string, Table> {
        return this._tables;
    }

    get comparison() : Comparison[] {
        return this._crossTableComparison;
    }

    get keywords() : string[] {
        return this._keywords;
    }

    get sparql() : string|undefined {
        return this._sparql;
    }

    get utterance() : string|undefined {
        return this._utterance;
    }

    get humanReadableInstanceOf() : boolean {
        return this._humanReadableInstanceOf;
    }

    get abstractProperty() : boolean {
        return this._abstractProperty;
    }
     
    updateTable(subject : string, update ?: Ast.BooleanExpression|Projection|string) {
        if (!(subject in this._tables)) 
            this._tables[subject] = { name: 'entity', projections: [], filters: [] };
        if (update instanceof Ast.BooleanExpression)  
            this._tables[subject].filters.push(update);
        else if (typeof update === 'string') 
            this._tables[subject].name = this._schema.getTable(update) ?? update;
        else if (update instanceof Projection)
            this._tables[subject].projections.push(update);
    }
    
    removeTable(subject : string) {
        delete this._tables[subject];
    }

    removeProjection(subject : string, variable : string) {
        const projections = this._tables[subject].projections;
        for (let i = 0; i < projections.length; i++) {
            const projection = projections[i];
            if (projection.variable! === variable) {
                projections.splice(i);
                break;
            }
        }
    }

    addCrossTableComparison(comp : Comparison) {
        this._crossTableComparison.push(comp);
    }

    private _init(sparql : string, utterance : string) {
        this._sparql = sparql;
        this._utterance = utterance;
        this._tables = {};
        this._crossTableComparison = [];
        this._helper.init();
        this._keywords = getSpans(this._tokenizer.tokenize(this._utterance).rawTokens.join(' '));
    }

    async convert(sparql : string, utterance : string) : Promise<Ast.Program> {
        // preprocess
        sparql = await this._preprocessor.preprocess(sparql, 'sparql');
        this._init(sparql, utterance);

        // try pattern match first
        const patternConverterResult = await this._patternConverter.fromSPARQL(sparql);
        if (patternConverterResult) {
            const program = Syntax.parse(patternConverterResult, Syntax.SyntaxType.Tokenized, {}, { timezone: 'utc' });
            return program as Ast.Program;
        }

        const query = this._sparqlParser.parse(sparql) as SelectQuery|AskQuery;

        // preprocess the query
        const preprocessor = new PreprocessVisitor();
        preprocessor.visit(query);

        // optimize for property path
        const propertyPathFinder = new PropertyPathFinder();
        propertyPathFinder.visit(query);
        const variablesForPropertyPath : Record<string, Triple> = {};
        for (const [variable, Triple] of Object.entries(propertyPathFinder.variableSubjectTriple)) {
            if (isSelectQuery(query) && query.variables.some((v) => isVariable(v) && v.value === variable))
                continue;
            const counter = propertyPathFinder.variableUsageCount[variable];
            if (counter.subject === 1 && counter.object === 1 && counter.other === 0)
                variablesForPropertyPath[variable] = Triple;
        }
        const propertyPathOptimizer = new PropertyPathOptimizer(variablesForPropertyPath);
        propertyPathOptimizer.visit(query);

        await this._parser.parse(query);
        return this._generator.generate(query);
    }    
}