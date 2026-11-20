"""Pre-flight workflow tooling shipped with the tac-qlib package.

``validate_workflow`` statically checks qrun YAML configs (structure, imports,
segments, qlib_init sanity) so bad workflows are refused before MLflow creates
any run. Kept inside the installed package (see pyproject ``packages``) so
plain site-packages installs have it too — ``rd_server``'s child-workflow path
degrades to a warning when it is missing, but it should be there.
"""
