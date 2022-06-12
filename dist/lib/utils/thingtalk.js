"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.elemType = exports.makeSubqueryVerificationProgram = exports.makeSubqueryProgram = exports.makeProgram = exports.baseQuery = exports.idArgument = void 0;
const assert_1 = __importDefault(require("assert"));
const thingtalk_1 = require("thingtalk");
function idArgument(entityType) {
    return new thingtalk_1.Ast.ArgumentDef(null, thingtalk_1.Ast.ArgDirection.OUT, 'id', new thingtalk_1.Type.Entity(`org.wikidata:${entityType}`), { nl: { canonical: { base: ['name'], passive_verb: ['named', 'called'] } } });
}
exports.idArgument = idArgument;
/**
 * A shortcut for quickly creating a basic query
 * @param domain the name of a domain
 * @return an invocation of a base domain query (no projection, no filter)
 */
function baseQuery(domain) {
    return new thingtalk_1.Ast.InvocationExpression(null, new thingtalk_1.Ast.Invocation(null, new thingtalk_1.Ast.DeviceSelector(null, 'org.wikidata', null, null), domain, [], null), null);
}
exports.baseQuery = baseQuery;
/**
 * A shortcut for creating a program from an query expression
 * @param expression a ThingTalk query expression
 * @returns a ThingTalk program
 */
function makeProgram(expression) {
    if (!(expression instanceof thingtalk_1.Ast.ChainExpression))
        expression = new thingtalk_1.Ast.ChainExpression(null, [expression], expression.schema);
    return new thingtalk_1.Ast.Program(null, [], [], [new thingtalk_1.Ast.ExpressionStatement(null, expression)]);
}
exports.makeProgram = makeProgram;
/**
 * A shortcut for creating a program with a subquery
 * @param main the main query
 * @param subquery the subquery
 * @returns a ThingTalk program
 */
function makeSubqueryProgram(main, subquery) {
    let filterTable = main;
    let parent;
    while (!(filterTable instanceof thingtalk_1.Ast.FilterExpression || filterTable instanceof thingtalk_1.Ast.InvocationExpression)) {
        parent = filterTable;
        filterTable = parent.expression;
    }
    if (filterTable instanceof thingtalk_1.Ast.FilterExpression)
        filterTable.filter = new thingtalk_1.Ast.AndBooleanExpression(null, [filterTable.filter, subquery]);
    else if (parent)
        parent.expression = new thingtalk_1.Ast.FilterExpression(null, filterTable, subquery, null);
    else
        main = new thingtalk_1.Ast.FilterExpression(null, filterTable, subquery, null);
    return new thingtalk_1.Ast.Program(null, [], [], [new thingtalk_1.Ast.ExpressionStatement(null, main)]);
}
exports.makeSubqueryProgram = makeSubqueryProgram;
/**
 * A shortcut for creating a program with subquery verification
 * @param main the main query
 * @param subqueries the boolean expressions to verify
 */
function makeSubqueryVerificationProgram(main, subqueries) {
    (0, assert_1.default)(subqueries.length > 0);
    const verification = subqueries.length === 1 ? subqueries[0] : new thingtalk_1.Ast.AndBooleanExpression(null, subqueries);
    const expression = new thingtalk_1.Ast.BooleanQuestionExpression(null, main, verification, null);
    return new thingtalk_1.Ast.Program(null, [], [], [new thingtalk_1.Ast.ExpressionStatement(null, expression)]);
}
exports.makeSubqueryVerificationProgram = makeSubqueryVerificationProgram;
/**
 * Get the element type of a ThingTalk type
 * @param type a ThingTalk type
 */
function elemType(type) {
    if (type instanceof thingtalk_1.Type.Array)
        return elemType(type.elem);
    if (type instanceof thingtalk_1.Type.Compound)
        return elemType(type.fields.value.type);
    return type;
}
exports.elemType = elemType;
//# sourceMappingURL=thingtalk.js.map