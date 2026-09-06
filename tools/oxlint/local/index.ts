import { defineRule, eslintCompatPlugin } from "@oxlint/plugins";

const noClassesRule = defineRule({
	meta: {
		type: "problem",
		docs: { description: "Disallow classes; model behaviour as functions over plain data records." },
		messages: { noClass: "Classes are not used here. Write functions over a plain data record instead." },
	},
	createOnce(context) {
		return {
			ClassDeclaration(node) {
				context.report({ node, messageId: "noClass" });
			},
			ClassExpression(node) {
				context.report({ node, messageId: "noClass" });
			},
		};
	},
});

const localPlugin = eslintCompatPlugin({
	meta: { name: "local" },
	rules: { "no-classes": noClassesRule },
});

export default localPlugin;
