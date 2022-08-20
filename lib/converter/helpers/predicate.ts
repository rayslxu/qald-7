import assert from 'assert';
import { Triple } from 'sparqljs';
import { 
    isVariable,
    isWikidataPredicateNode,
    isWikidataPropertyPredicateNode,
    isWikidataPropertyQualifierNode,
    isWikidataPropertyStatementNode
} from '../../utils/sparqljs-typeguard';
import { Predicate } from '../sparql2thingtalk';
import SPARQLToThingTalkConverter from '../sparql2thingtalk';
import { 
    PROPERTY_PREDICATE_PREFIX, 
    PROPERTY_QUALIFIER_PREFIX, 
    PROPERTY_STATEMENT_PREFIX } from '../../utils/wikidata';
import { Ast } from 'thingtalk';
import { ArrayCollection } from '../../utils/misc';
import { elemType } from '../../utils/thingtalk';

// handles predicate with qualifiers
export default class PredicateParser {
    private _converter : SPARQLToThingTalkConverter;
    private _predicates : Predicate[];

    constructor(converter : SPARQLToThingTalkConverter) {
        this._converter = converter;
        this._predicates = [];
    }

    get predicates() : Predicate[] {
        return this._predicates;
    }

    reset() {
        this._predicates = [];
    }

    private _findMatchingPredicate(update : Predicate) : Predicate|null {
        for (const predicate of this._predicates) {
            if ((predicate.property !== undefined && predicate.property === update.property) ||
                (predicate.predicate_variable !== undefined && predicate.predicate_variable === update.predicate_variable)) 
                return predicate;
        }
        return null;
    }

    addOrUpdatePredicate(predicate : Predicate) {
        const match = this._findMatchingPredicate(predicate);
        if (!match) {
            this._predicates.push(predicate);
        } else {
            if (predicate.qualifiers.length > 0)
                match.qualifiers.push(...predicate.qualifiers);
            if (predicate.property)
                match.property = predicate.property;
            if (predicate.table)
                match.table = predicate.table;
            if (predicate.value)
                match.value = predicate.value;
            if (predicate.predicate_variable)
                match.predicate_variable = predicate.predicate_variable;
            if (predicate.op)
                match.op = predicate.op;
            if (predicate.isVariable !== undefined)
                match.isVariable = predicate.isVariable;
        } 
    }
    
    async parse(triple : Triple) {
        assert(isWikidataPredicateNode(triple.predicate));
        const subject : string = triple.subject.value;
        const predicate : string = triple.predicate.value;
        const object : string = triple.object.value;

        if (isWikidataPropertyPredicateNode(triple.predicate)) {
            const property = this._converter.schema.getProperty(predicate.slice(PROPERTY_PREDICATE_PREFIX.length));
            if (!property)
                throw new Error(`Failed to find property ${predicate} in schema`);
            this.addOrUpdatePredicate({
                table: subject,
                property,
                predicate_variable: object,
                qualifiers: []
            });
        } else if (isWikidataPropertyQualifierNode(triple.predicate)) {
            const property = this._converter.schema.getProperty(predicate.slice(PROPERTY_QUALIFIER_PREFIX.length));
            if (!property)
                throw new Error(`Failed to find property ${predicate} in schema`);
            this.addOrUpdatePredicate({
                predicate_variable: subject,
                qualifiers: [{
                    property,
                    op: '==',
                    value: object,
                    isVariable: isVariable(triple.object)
                }]
            });
        } else if (isWikidataPropertyStatementNode(triple.predicate)) {
            const property = this._converter.schema.getProperty(predicate.slice(PROPERTY_STATEMENT_PREFIX.length));
            if (!property)
                throw new Error(`Failed to find property ${predicate} in schema`);
            this.addOrUpdatePredicate({
                property,
                predicate_variable: subject,
                value: object,
                isVariable : isVariable(triple.object),
                qualifiers: []
            });
        }
    }

    _hasFieldProjection(table : string, property : string ) {
        return this._converter.tables[table].projections.some((p) => {
            return typeof p.property === 'string' && p.property.startsWith(`${property}.`);
        });
    }

    _getAndDeleteFieldProjection(table : string, property : string) {
        for (const p of this._converter.tables[table].projections) {
            if (typeof p.property === 'string' && p.property.startsWith((`${property}.`))) {
                this._converter.removeProjection(table, p.variable!);
                return [p.property.slice(property.length + 1), p.variable];
            }
        }
        return null;
    }

    async _convertPredicate(predicate : Predicate) {
        assert(predicate.table && predicate.property && predicate.qualifiers.length > 0);

        const filtersBySubject = new ArrayCollection<Ast.BooleanExpression>();
        if (predicate.value) { 
            // load all qualifiers        
            const filters = [];
            for (const qualifier of predicate.qualifiers) {
                if (qualifier.isVariable) {
                    this._converter.updateTable(predicate.table, {
                        property: `${predicate.property}.${qualifier.property}`,
                        variable: qualifier.value
                    });
                    continue; 
                }
                const qualifierType = this._converter.schema.getPropertyType(`${predicate.property}.${qualifier.property}`);
                filters.push(await this._converter.helper.makeAtomBooleanExpression(
                    qualifier.property,
                    qualifier.value,
                    qualifier.op,
                    elemType(qualifierType)
                ));
            }
            
            const propertyType = this._converter.schema.getPropertyType(predicate.property);
            // if the predicate has an variable value, add the qualified value to projection
            if (predicate.isVariable === true) {
                const proj = new Ast.FilterValue(
                    new Ast.VarRefValue(predicate.property),
                    filters.length > 1 ? new Ast.AndBooleanExpression(null, filters) : filters[0]
                );
                this._converter.updateTable(predicate.table, {
                    property: proj,
                    variable: predicate.value
                });
            // if the predicate has an entity value, but there exists an projection on its field
            // add an ArrayFieldValue projection
            } else if (this._hasFieldProjection(predicate.table, predicate.property)) {
                filters.push(await this._converter.helper.makeAtomBooleanExpression(
                    'value',
                    predicate.value, 
                    '==',
                    elemType(propertyType)
                ));
                const proj = new Ast.FilterValue(
                    new Ast.VarRefValue(predicate.property),
                    filters.length > 1 ? new Ast.AndBooleanExpression(null, filters) : filters[0]
                );
                const [field, variable] = this._getAndDeleteFieldProjection(predicate.table, predicate.property)!;
                this._converter.updateTable(predicate.table, {
                    property: new Ast.ArrayFieldValue(proj, field!),
                    variable
                });
            // if the predicate has an entity value, make a qualified filter
            } else {
                const lhs = new Ast.FilterValue(
                    new Ast.VarRefValue(predicate.property),
                    filters.length > 1 ? new Ast.AndBooleanExpression(null, filters) : filters[0]
                );
                let operator = predicate.op ?? '==';
                if (operator === '>' || operator === '<') 
                    operator = operator + '=';
                const rhs = await this._converter.helper.convertValue(predicate.value, propertyType);
                const filter = new Ast.ComputeBooleanExpression(null, lhs, operator, rhs, null);
                filtersBySubject.add(predicate.table, filter);
            }
        } else {
            for (const qualifier of predicate.qualifiers) {
                if (qualifier.isVariable) {
                    this._converter.updateTable(predicate.table, {
                        property: `${predicate.property}.${qualifier.property}`,
                        variable: qualifier.value
                    });
                    continue; 
                }
                const qualifierType = this._converter.schema.getPropertyType(`${predicate.property}.${qualifier.property}`);
                const filter = await this._converter.helper.makeAtomBooleanExpression(
                    `${predicate.property}.${qualifier.property}`,
                    qualifier.value,
                    qualifier.op,
                    elemType(qualifierType)
                );
                filtersBySubject.add(predicate.table, filter);
            }
        }
        return filtersBySubject;
    }

    async convert() {
        const filtersBySubject = new ArrayCollection<Ast.BooleanExpression>();
        for (const predicate of this._predicates)
            filtersBySubject.merge(await this._convertPredicate(predicate));
        return filtersBySubject;
    }
    
}