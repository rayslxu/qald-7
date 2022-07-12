import assert from 'assert';
import { Ast, Type } from 'thingtalk';
import { 
    BgpPattern,
    Expression,
    Grouping,
    FilterPattern,
    UnionPattern,
    Variable,
    Wildcard,
    Ordering,
    SelectQuery,
    AskQuery
} from 'sparqljs';
import {
    isVariable,
    isVariableExpression,
    isBasicGraphPattern,
    isAggregateExpression,
    isAskQuery,
    isSelectQuery
} from '../../utils/sparqljs-typeguard';
import {
    ENTITY_PREFIX,
    PROPERTY_PREFIX
} from '../../utils/wikidata';
import {
    baseQuery,
    elemType,
    isIdFilter
} from '../../utils/thingtalk';
import {
    ArrayCollection
} from '../../utils/misc';
import { parseSpecialUnion } from '../../utils/sparqljs';
import TripleParser from './triple';
import FilterParser from './filter';
import ValueConverter from './value';
import GroupParser from './group';
import {
    Table,
    Aggregation,
    Projection
} from '../sparql2thingtalk';
import SPARQLToThingTalkConverter from '../sparql2thingtalk';

function isAggregation(v : any) : v is Aggregation {
    return typeof v === 'object' && 'op' in v && 'variable' in v;
}

export default class ConverterHelper {
    private _converter : SPARQLToThingTalkConverter;
    private _triple : TripleParser;
    private _filter : FilterParser;
    private _value : ValueConverter;
    private _group : GroupParser;

    constructor(converter : SPARQLToThingTalkConverter) {
        this._converter = converter;
        this._triple = new TripleParser(converter);
        this._filter = new FilterParser(converter);
        this._value = new ValueConverter(converter);
        this._group = new GroupParser(converter);
    }

    async convertValue(value : any, type : Type) {
        return this._value.toThingTalkValue(value, type);
    }

    async parseGroup(having : Expression, group : Grouping) {
        return this._group.parse(having, group);
    }

    async parseTriples(clause : BgpPattern) : Promise<ArrayCollection<Ast.BooleanExpression>> {
        return this._triple.parse(clause);
    }

    async parseFilter(clause : FilterPattern) : Promise<ArrayCollection<Ast.BooleanExpression>> {
        return this._filter.parse(clause);
    }

    async parseUnion(clause : UnionPattern) : Promise<ArrayCollection<Ast.BooleanExpression>> {
        const triple = parseSpecialUnion(clause);
        if (triple) 
            return this.parseTriples({ type: 'bgp', triples: [triple] });
        
        const results : Array<ArrayCollection<Ast.BooleanExpression>> = [];
        for (const pattern of clause.patterns) {
            assert(isBasicGraphPattern(pattern));
            results.push(await this.parseTriples(pattern));
        }
        let existedSubject : string|null = null;
        const operands : Ast.BooleanExpression[] = [];
        for (const filtersBySubject of results) {
            if (filtersBySubject.size > 1)
                throw new Error('Unsupported: multiple subjects in a union');
            const subject = filtersBySubject.keys[0];
            const filters = filtersBySubject.get(subject);
            assert(filters.length > 0);
            const filter = filters.length === 1 ? filters[0] : new Ast.AndBooleanExpression(null, filters);
            if (!existedSubject)
                existedSubject = subject;
            else if (subject !== existedSubject)
                throw new Error('Unsupported: multiple subjects in a union');
            operands.push(filter);
        }
        return new ArrayCollection(existedSubject!, new Ast.OrBooleanExpression(null, operands));
    }

    parseVariables(variables : Variable[]|[Wildcard]) : ArrayCollection<Projection|Aggregation> {
        const projectionsOrAggregationsBySubject = new ArrayCollection<Projection|Aggregation>();
        for (const variable of variables) {
            if (isVariable(variable)) {
                for (const [subject, table] of Object.entries(this._converter.tables)) {
                    if (subject === variable.value) {
                        projectionsOrAggregationsBySubject.add(subject, { 
                            property: 'id', 
                            variable: variable.value 
                        });
                    }
                    for (const projection of table.projections) {
                        if (projection.variable === variable.value) {
                            projectionsOrAggregationsBySubject.add(subject, { 
                                property: projection.property, 
                                variable: variable.value 
                            });
                        }
                    }
                }
            } else if (isVariableExpression(variable) && isAggregateExpression(variable.expression, 'count')) {
                const expression = variable.expression.expression;
                assert(isVariable(expression));
                projectionsOrAggregationsBySubject.add(expression.value, { 
                    op: 'count', 
                    variable: expression.value 
                });
            } else {
                throw new Error('Unsupported type of variable: ' + variable);
            }
        }
        return projectionsOrAggregationsBySubject;
    }
    
    addFilters(base : Ast.Expression, filters : Ast.BooleanExpression[]) : Ast.Expression {
        if (filters.length === 0)
            return base;
        const filter = filters.length > 1 ? new Ast.AndBooleanExpression(null, filters) : filters[0];
        return new Ast.FilterExpression(null, base, filter, null);
        
    }

    addProjectionsAndAggregations(base : Ast.Expression, projectionsAndAggregations : Array<Projection|Aggregation>) {
        const projections = projectionsAndAggregations.filter((v) => !isAggregation(v)) as Projection[];
        const aggregations = projectionsAndAggregations.filter(isAggregation) as Aggregation[];
        let expression = base;
        if (projections.length > 0 && !(projections.length === 1 && projections[0].property === 'id')) {
            expression = new Ast.ProjectionExpression2(
                null, 
                expression, 
                projections.map((p) => 
                    new Ast.ProjectionElement(
                        p.property, 
                        null, 
                        p.type ? [new Type.Entity(`org.wikidata:${p.type}`)] : []
                    )
                ),
                null
            );
        }
        if (aggregations.length > 0) {
            assert(aggregations.length === 1);
            const aggregation = aggregations[0];
            assert(aggregation.op === 'count');
            expression = new Ast.AggregationExpression(null, expression, '*', 'count', null);
        }
        return expression;
    }

    addOrdering(base : Ast.Expression, table : Table, ordering ?: Ordering[]) : Ast.Expression {
        if (!ordering || ordering.length === 0)
            return base;
        if (ordering.length > 1)
            throw new Error('Unsupported: ordering on multiple varialbles');
        
        const order = ordering[0];
        const expression = order.expression;
        assert(isVariable(expression));
        const projection = table.projections.find((proj) => proj.variable === expression.value);
        if (!projection)
            throw new Error('Failed to find the variable for sorting');
        if (typeof projection.property !== 'string')
            throw new Error('Unsupported: sort on property path');
        const property = new Ast.Value.VarRef(projection.property);
        const direction = order.descending ? 'desc' : 'asc';
        return new Ast.SortExpression(null, base, property, direction, null);
    }

    addLimit(base : Ast.Expression, limit ?: number) : Ast.Expression {
        if (limit)
            return  new Ast.IndexExpression(null, base, [new Ast.Value.Number(limit)], null);
        return base;
    }

    addVerification(base : Ast.Expression, filters : Ast.BooleanExpression[]) : Ast.Expression {
        let idFilter : Ast.BooleanExpression|null = null;
        const operands = [];
        for (const filter of filters) {
            if (isIdFilter(filter))
                idFilter = filter;
            else 
                operands.push(filter);
        }
        if (idFilter) {
            base = new Ast.FilterExpression(null, base, idFilter, null);
            const verification = operands.length > 1 ? new Ast.AndBooleanExpression(null, operands) : operands[0];
            return new Ast.BooleanQuestionExpression(null, base, verification, null);
        } else {
            const filterdTable = this.addFilters(base, operands);
            const aggregatedTable = new Ast.AggregationExpression(null, filterdTable, '*', 'count', null);
            return new Ast.BooleanQuestionExpression(
                null,
                aggregatedTable,
                new Ast.AtomBooleanExpression(null, 'count', '>=', new Ast.Value.Number(1), null),
                null
            );
        }
    }

    /**
     * Preprocess tables to simplify the conversion 
     */
    preprocessTables(projectionsAndAggregationsBySubject : ArrayCollection<Projection|Aggregation>) {
        // check tables with only domain information, it can potentially be resolved with a type annotation
        // on another table's projection
        // only apply to selection not verification
        for (const [subject, table] of Object.entries(this._converter.tables)) {
            if (subject.startsWith(ENTITY_PREFIX))
                continue;
            let isProjected = false;
            if (table.name !== 'entity' && table.filters.length === 0 && table.projections.length === 0 ) {
                for (const [subject2, ] of projectionsAndAggregationsBySubject.iterate()) {
                    if (subject === subject2)
                        continue;
                    const projectionsAndAggregations = projectionsAndAggregationsBySubject.get(subject2);
                    const proj = projectionsAndAggregations.find((p) => 
                        !isAggregation(p) && p.variable === subject
                    ) as Projection;
                    if (proj) {
                        isProjected = true;
                        proj.type = table.name;
                    }
                }
            }
            if (isProjected)
                this._converter.removeTable(subject);
        }
    }

    /**
     * Find the main subject among tables, which will be the main function 
     * for ThingTalk, other tables will be added as subqueries
     * @param queryType the type of the query
     */
    getMainSubject(query : SelectQuery|AskQuery) : string {
        const tables = this._converter.tables;
        // if there is only one table, return it
        if (Object.keys(tables).length === 1)
            return Object.keys(tables)[0];

        // if there are multiple tables:
        // (1) if there exist an ordering, the table project to the ordering should be chosen
        if (isSelectQuery(query) && query.order && query.order.length === 1) {
            const order = query.order[0];
            const expression = order.expression;
            assert(isVariable(expression));
            for (const [subject, table] of Object.entries(tables)) {
                if (table.projections.some((p) => p.variable === expression.value))
                    return subject;
            }
        }
        // (2) if a table does not have any projection, it should not be the main subject
        // (3) for ASK query, the main subject should have ID filter
        const candidates = [];
        for (const [subject, table] of Object.entries(tables)) {
            if (table.projections.length === 0)
                continue;
            if (!table.filters.some(isIdFilter) && isAskQuery(query))
                continue;
            candidates.push(subject);
        }
        if (candidates.length === 0)
            throw new Error('Failed to find the main subject');
        // (4) if there are still multiple candidates, sort by complexity
        function complexity(subject : string) : number {
            const table = tables[subject];
            return table.filters.length + table.projections.length;
        }
        candidates.sort((a, b) => complexity(b) - complexity(a));
        return candidates[0];
    }
    
    makeSubquery(mainSubject : string, subquerySubject : string) : Ast.BooleanExpression {
        const tables = this._converter.tables;
        const mainTable = tables[mainSubject];
        const subqueryTable = tables[subquerySubject];
        const subquery = this.addFilters(baseQuery(subqueryTable.name), subqueryTable.filters);

        // handle comparison of two entities with subquery  
        if (this._converter.comparison.length === 1) {
            const comp = this._converter.comparison[0];
            const mainProperty = mainTable.projections.find((proj) => 
                proj.variable && (proj.variable === comp.lhs || proj.variable === comp.rhs)
            )!.property as string;
            const subqueryProperty = subqueryTable.projections.find((proj) => 
                proj.variable && (proj.variable === comp.lhs || proj.variable === comp.rhs)
            )!.property as string;
            return new Ast.ComparisonSubqueryBooleanExpression(
                null,
                new Ast.Value.VarRef(mainProperty),
                comp.operator,
                new Ast.ProjectionExpression(null, subquery, [subqueryProperty], [], [], null),
                null
            );

        } 
        if (mainTable.projections.some((proj) => proj.variable === subquerySubject)) {
            const projection = mainTable.projections.find((proj) => proj.variable === subquerySubject);
            const property = projection!.property;
            if (typeof property !== 'string')
                throw new Error(`Subquery on property path not supported`);
            return new Ast.ComparisonSubqueryBooleanExpression(
                null,
                new Ast.Value.VarRef(property),
                this._converter.schema.getPropertyType(property) instanceof Type.Array ? 'contains' : '==',
                new Ast.ProjectionExpression(null, subquery, ['id'], [], [], null),
                null
            );
        } 
        if (subqueryTable.projections.some((proj) => proj.variable === mainSubject)) {
            const projection = subqueryTable.projections.find((proj) => proj.variable === mainSubject);
            const property = projection!.property;
            if (typeof property !== 'string')
                throw new Error(`Subquery on property path not supported`);
            return new Ast.ComparisonSubqueryBooleanExpression(
                null,
                new Ast.Value.VarRef('id'),
                this._converter.schema.getPropertyType(property) instanceof Type.Array ? 'in_array' : '==',
                subquery,
                null
            );
        } 
        throw new Error('Failed to generate subquery');
    }

    async makeAtomBooleanExpression(property : string, 
                                    value : any, 
                                    operator ?: string, 
                                    valueType ?: Type) : Promise<Ast.AtomBooleanExpression> {
        let propertyLabel;
        if (property.startsWith(PROPERTY_PREFIX)) {
            property = property.slice(PROPERTY_PREFIX.length);
            propertyLabel = this._converter.schema.getProperty(property);
        } else {
            propertyLabel = property;
        }
        const propertyType = this._converter.schema.getPropertyType(propertyLabel);
        if (operator === '>' || operator === '<') 
            operator = operator + '=';
        if (valueType === Type.String) 
            operator = propertyType instanceof Type.Array ? 'contains~' : '=~';
        return new Ast.AtomBooleanExpression(
            null,
            propertyLabel,
            operator ?? (propertyType instanceof Type.Array ? 'contains' : '=='),
            await this._value.toThingTalkValue(value, valueType ?? elemType(propertyType)),
            null
        );
    }
}